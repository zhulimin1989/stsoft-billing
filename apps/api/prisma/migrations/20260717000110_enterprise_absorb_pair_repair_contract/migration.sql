-- Immutable, pair-scoped repair contract for the retired enterprise-absorb
-- writer. This migration does not restore any online account-transfer path.

BEGIN;

CREATE TABLE "balance_ledger_account_transfer_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "proof_version" INTEGER NOT NULL DEFAULT 1,
  "run_id" TEXT NOT NULL,
  "source_repair_account_id" TEXT NOT NULL,
  "target_repair_account_id" TEXT NOT NULL,
  "source_billing_account_id" TEXT NOT NULL,
  "target_billing_account_id" TEXT NOT NULL,
  "out_transaction_id" TEXT NOT NULL UNIQUE,
  "in_transaction_id" TEXT NOT NULL UNIQUE,
  "amount_usd" NUMERIC(20, 12) NOT NULL,
  "original_xmin" BIGINT NOT NULL,
  "out_transaction_snapshot" JSONB NOT NULL,
  "in_transaction_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_transfer_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_source_repair_fkey"
    FOREIGN KEY ("source_repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_target_repair_fkey"
    FOREIGN KEY ("target_repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_source_account_fkey"
    FOREIGN KEY ("source_billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_target_account_fkey"
    FOREIGN KEY ("target_billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_out_tx_fkey"
    FOREIGN KEY ("out_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_in_tx_fkey"
    FOREIGN KEY ("in_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "source_billing_account_id" <> "target_billing_account_id"
    AND "source_repair_account_id" <> "target_repair_account_id"
    AND "out_transaction_id" <> "in_transaction_id"
    AND "amount_usd" > 0
    AND "original_xmin" > 0
  )
);

CREATE UNIQUE INDEX "balance_ledger_transfer_repairs_run_pair_key"
  ON "balance_ledger_account_transfer_repairs"(
    "run_id", "source_billing_account_id", "target_billing_account_id"
  );
CREATE INDEX "balance_ledger_transfer_repairs_source_created_idx"
  ON "balance_ledger_account_transfer_repairs"("source_billing_account_id", "created_at");
CREATE INDEX "balance_ledger_transfer_repairs_target_created_idx"
  ON "balance_ledger_account_transfer_repairs"("target_billing_account_id", "created_at");

CREATE TABLE "balance_ledger_account_transfer_grants" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "transfer_repair_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL UNIQUE,
  "source_funding_transaction_id" TEXT NOT NULL UNIQUE,
  "transferred_amount_usd" NUMERIC(20, 12) NOT NULL,
  "transferred_paid_usd" NUMERIC(20, 12) NOT NULL,
  "transferred_bonus_usd" NUMERIC(20, 12) NOT NULL,
  "source_consumed_amount_usd" NUMERIC(20, 12) NOT NULL,
  "source_consumed_paid_usd" NUMERIC(20, 12) NOT NULL,
  "source_consumed_bonus_usd" NUMERIC(20, 12) NOT NULL,
  "target_consumed_amount_usd" NUMERIC(20, 12) NOT NULL,
  "target_consumed_paid_usd" NUMERIC(20, 12) NOT NULL,
  "target_consumed_bonus_usd" NUMERIC(20, 12) NOT NULL,
  "source_allocation_count" BIGINT NOT NULL,
  "target_allocation_count" BIGINT NOT NULL,
  "source_allocations_sha256" TEXT NOT NULL,
  "target_allocations_sha256" TEXT NOT NULL,
  "grant_snapshot" JSONB NOT NULL,
  "funding_transaction_snapshot" JSONB NOT NULL,
  "source_allocations_snapshot" JSONB NOT NULL,
  "target_allocations_snapshot" JSONB NOT NULL,
  "invoice_evidence_sha256" TEXT NOT NULL,
  "invoice_evidence_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_transfer_grants_transfer_fkey"
    FOREIGN KEY ("transfer_repair_id") REFERENCES "balance_ledger_account_transfer_repairs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_grants_grant_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_grants_funding_fkey"
    FOREIGN KEY ("source_funding_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transfer_grants_shape_check" CHECK (
    "transferred_amount_usd" > 0
    AND "transferred_paid_usd" >= 0
    AND "transferred_bonus_usd" >= 0
    AND "transferred_amount_usd" = "transferred_paid_usd" + "transferred_bonus_usd"
    AND "source_consumed_amount_usd" >= 0
    AND "source_consumed_paid_usd" >= 0
    AND "source_consumed_bonus_usd" >= 0
    AND "source_consumed_amount_usd" = "source_consumed_paid_usd" + "source_consumed_bonus_usd"
    AND "target_consumed_amount_usd" >= 0
    AND "target_consumed_paid_usd" >= 0
    AND "target_consumed_bonus_usd" >= 0
    AND "target_consumed_amount_usd" = "target_consumed_paid_usd" + "target_consumed_bonus_usd"
    AND "source_allocation_count" >= 0
    AND "target_allocation_count" >= 0
    AND "source_allocations_sha256" ~ '^[0-9a-f]{64}$'
    AND "target_allocations_sha256" ~ '^[0-9a-f]{64}$'
    AND "invoice_evidence_sha256" ~ '^[0-9a-f]{64}$'
    -- The retired writer instance under repair transferred paid-only grants.
    -- Keeping V1 narrow prevents this audit table becoming a generic transfer API.
    AND "transferred_bonus_usd" = 0
    AND "source_consumed_bonus_usd" = 0
    AND "target_consumed_bonus_usd" = 0
  )
);
CREATE INDEX "balance_ledger_transfer_grants_transfer_idx"
  ON "balance_ledger_account_transfer_grants"("transfer_repair_id");

CREATE TABLE "balance_ledger_grant_creation_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "repair_kind" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "balance_transaction_id" TEXT NOT NULL UNIQUE,
  -- Deliberately no FK to balance_grants: the proof must be inserted before
  -- the guarded grant INSERT. A deferred trigger below requires the exact row
  -- to exist before COMMIT.
  "balance_grant_id" TEXT NOT NULL UNIQUE,
  "idempotency_key" TEXT NOT NULL,
  "idempotency_scope" TEXT NOT NULL,
  "idempotency_snapshot" JSONB NOT NULL,
  "transaction_snapshot" JSONB NOT NULL,
  "grant_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_grant_creation_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_creation_repairs_account_run_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_creation_repairs_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_creation_repairs_transaction_fkey"
    FOREIGN KEY ("balance_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_creation_repairs_shape_check" CHECK (
    "repair_kind" = 'LEGACY_ENTERPRISE_ADMIN_RECHARGE_V1'
    AND "idempotency_scope" = 'admin:adjust-balance'
    AND "balance_grant_id" = 'repair-admin-recharge:' || "balance_transaction_id"
  )
);
CREATE UNIQUE INDEX "balance_ledger_grant_creation_repairs_run_tx_key"
  ON "balance_ledger_grant_creation_repairs"(
    "run_id", "billing_account_id", "balance_transaction_id"
  );
CREATE INDEX "balance_ledger_grant_creation_repairs_account_created_idx"
  ON "balance_ledger_grant_creation_repairs"("billing_account_id", "created_at");

CREATE TABLE "balance_ledger_grant_component_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "before_snapshot" JSONB NOT NULL,
  "after_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_grant_component_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_component_repairs_repair_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_component_repairs_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_component_repairs_grant_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "balance_ledger_grant_component_repairs_run_grant_key"
  ON "balance_ledger_grant_component_repairs"("run_id", "grant_id");
CREATE INDEX "balance_ledger_grant_component_repairs_account_created_idx"
  ON "balance_ledger_grant_component_repairs"("billing_account_id", "created_at");

CREATE OR REPLACE FUNCTION "reject_balance_enterprise_absorb_repair_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'enterprise absorb repair proof is append-only table=% id=%',
    TG_TABLE_NAME, OLD."id"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_transfer_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_account_transfer_repairs"
FOR EACH ROW EXECUTE FUNCTION "reject_balance_enterprise_absorb_repair_mutation"();
CREATE TRIGGER "balance_ledger_transfer_grants_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_account_transfer_grants"
FOR EACH ROW EXECUTE FUNCTION "reject_balance_enterprise_absorb_repair_mutation"();
CREATE TRIGGER "balance_ledger_grant_creation_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_grant_creation_repairs"
FOR EACH ROW EXECUTE FUNCTION "reject_balance_enterprise_absorb_repair_mutation"();
CREATE TRIGGER "balance_ledger_grant_component_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_grant_component_repairs"
FOR EACH ROW EXECUTE FUNCTION "reject_balance_enterprise_absorb_repair_mutation"();

CREATE OR REPLACE FUNCTION "validate_balance_enterprise_absorb_transfer_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  repair_run_status TEXT;
  source_repair RECORD;
  target_repair RECORD;
  source_account RECORD;
  target_account RECORD;
  out_row RECORD;
  in_row RECORD;
  out_snapshot JSONB;
  in_snapshot JSONB;
  out_xmin BIGINT;
  in_xmin BIGINT;
  anchor RECORD;
BEGIN
  SELECT "status" INTO repair_run_status
  FROM "balance_ledger_repair_runs" WHERE "id" = NEW."run_id";
  SELECT * INTO source_repair FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."source_repair_account_id";
  SELECT * INTO target_repair FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."target_repair_account_id";
  SELECT * INTO source_account FROM "billing_accounts"
  WHERE "id" = NEW."source_billing_account_id";
  SELECT * INTO target_account FROM "billing_accounts"
  WHERE "id" = NEW."target_billing_account_id";
  SELECT transaction_row.*, to_jsonb(transaction_row) AS snapshot,
      (transaction_row.xmin::TEXT)::BIGINT AS tuple_xmin
    INTO out_row
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."id" = NEW."out_transaction_id";
  SELECT transaction_row.*, to_jsonb(transaction_row) AS snapshot,
      (transaction_row.xmin::TEXT)::BIGINT AS tuple_xmin
    INTO in_row
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."id" = NEW."in_transaction_id";
  out_snapshot := out_row.snapshot;
  in_snapshot := in_row.snapshot;
  out_xmin := out_row.tuple_xmin;
  in_xmin := in_row.tuple_xmin;
  SELECT * INTO anchor FROM "tenants" WHERE "id" = out_row."tenant_id";

  IF repair_run_status IS DISTINCT FROM 'RUNNING'
    OR source_repair."id" IS NULL
    OR target_repair."id" IS NULL
    OR source_repair."run_id" IS DISTINCT FROM NEW."run_id"
    OR target_repair."run_id" IS DISTINCT FROM NEW."run_id"
    OR source_repair."billing_account_id" IS DISTINCT FROM NEW."source_billing_account_id"
    OR target_repair."billing_account_id" IS DISTINCT FROM NEW."target_billing_account_id"
    OR source_repair."status" IS DISTINCT FROM 'RUNNING'
    OR target_repair."status" IS DISTINCT FROM 'RUNNING'
    OR source_account."type" IS DISTINCT FROM 'personal'
    OR target_account."type" IS DISTINCT FROM 'enterprise'
    OR lower(btrim(source_account."currency")) !~ '^[a-z]{3}$'
    OR lower(btrim(target_account."currency")) !~ '^[a-z]{3}$'
    OR source_account."status" IS DISTINCT FROM 'active'
    OR target_account."status" IS DISTINCT FROM 'active'
    OR source_account."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR target_account."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR source_account."owner_user_id" IS NULL
    OR source_account."owner_user_id" IS DISTINCT FROM target_account."owner_user_id"
    OR out_row."id" IS NULL
    OR in_row."id" IS NULL
    OR out_snapshot IS DISTINCT FROM NEW."out_transaction_snapshot"
    OR in_snapshot IS DISTINCT FROM NEW."in_transaction_snapshot"
    OR out_xmin IS DISTINCT FROM NEW."original_xmin"
    OR in_xmin IS DISTINCT FROM NEW."original_xmin"
    OR out_row."billing_account_id" IS DISTINCT FROM NEW."source_billing_account_id"
    OR in_row."billing_account_id" IS DISTINCT FROM NEW."target_billing_account_id"
    OR out_row."type"::TEXT IS DISTINCT FROM 'ADJUST'
    OR in_row."type"::TEXT IS DISTINCT FROM 'ADJUST'
    OR out_row."amount_usd" IS DISTINCT FROM -NEW."amount_usd"
    OR in_row."amount_usd" IS DISTINCT FROM NEW."amount_usd"
    OR out_row."balance_after_usd" IS DISTINCT FROM 0
    OR in_row."balance_after_usd" - in_row."amount_usd" IS DISTINCT FROM 0
    OR out_row."description" IS DISTINCT FROM
      'enterprise-absorb:out to=' || NEW."target_billing_account_id"
    OR in_row."description" IS DISTINCT FROM
      'enterprise-absorb:in from=' || NEW."source_billing_account_id"
    OR out_row."user_id" IS DISTINCT FROM in_row."user_id"
    OR out_row."tenant_id" IS DISTINCT FROM in_row."tenant_id"
    OR out_row."product_id" IS NOT NULL OR in_row."product_id" IS NOT NULL
    OR out_row."token_usage_id" IS NOT NULL OR in_row."token_usage_id" IS NOT NULL
    OR out_row."order_id" IS NOT NULL OR in_row."order_id" IS NOT NULL
    OR out_row."operation_key" IS NOT NULL OR in_row."operation_key" IS NOT NULL
    OR out_row."created_at" > in_row."created_at"
    OR anchor."id" IS NULL
    OR anchor."owner_user_id" IS DISTINCT FROM source_account."owner_user_id"
    OR anchor."billing_account_id" IS DISTINCT FROM NEW."target_billing_account_id"
    OR anchor."status" IS DISTINCT FROM 'active'
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:enterprise-absorb:' || NEW."run_id" || ':'
      || NEW."out_transaction_id" || ':' || NEW."in_transaction_id"
    )
  THEN
    RAISE EXCEPTION
      'enterprise absorb parent proof invalid run=% source=% target=% out=% in=%',
      NEW."run_id", NEW."source_billing_account_id", NEW."target_billing_account_id",
      NEW."out_transaction_id", NEW."in_transaction_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_ledger_transfer_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_account_transfer_repairs"
FOR EACH ROW EXECUTE FUNCTION "validate_balance_enterprise_absorb_transfer_insert"();

CREATE OR REPLACE FUNCTION "balance_enterprise_absorb_order_is_single_paid_grant"(
  target_order_id TEXT,
  target_funding_transaction_id TEXT,
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    target_order_id IS NOT NULL
    AND target_funding_transaction_id IS NOT NULL
    AND target_grant_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "balance_transactions" funding
      WHERE funding."id" = target_funding_transaction_id
        AND funding."order_id" = target_order_id
        AND funding."type"::TEXT = 'RECHARGE'
        AND funding."amount_usd" > 0
    )
    AND EXISTS (
      SELECT 1
      FROM "balance_grants" grant_row
      WHERE grant_row."id" = target_grant_id
        AND grant_row."order_id" = target_order_id
    )
    AND (
      SELECT COUNT(*)
      FROM "balance_transactions" transaction_row
      WHERE transaction_row."order_id" = target_order_id
        AND transaction_row."type"::TEXT = 'RECHARGE'
    ) = 1
    AND (
      SELECT COUNT(*)
      FROM "balance_transactions" transaction_row
      WHERE transaction_row."order_id" = target_order_id
        AND transaction_row."amount_usd" > 0
    ) = 1
    AND (
      SELECT COUNT(*)
      FROM "balance_grants" grant_row
      WHERE grant_row."order_id" = target_order_id
    ) = 1,
    FALSE
  )
$$;

CREATE OR REPLACE FUNCTION "validate_balance_enterprise_absorb_grant_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  transfer_row RECORD;
  grant_row RECORD;
  funding_row RECORD;
  order_row RECORD;
  source_allocations JSONB;
  target_allocations JSONB;
  current_invoice JSONB;
  source_amount NUMERIC;
  source_paid NUMERIC;
  source_bonus NUMERIC;
  target_amount NUMERIC;
  target_paid NUMERIC;
  target_bonus NUMERIC;
  foreign_count BIGINT;
  source_count BIGINT;
  target_count BIGINT;
  unsafe_invoice_count BIGINT;
  expiry_count BIGINT;
  refund_count BIGINT;
BEGIN
  SELECT transfer.*, run."status" AS run_status,
      source_repair."status" AS source_repair_status,
      target_repair."status" AS target_repair_status,
      target_account."currency" AS target_account_currency
    INTO transfer_row
  FROM "balance_ledger_account_transfer_repairs" transfer
  JOIN "balance_ledger_repair_runs" run ON run."id" = transfer."run_id"
  JOIN "balance_ledger_repair_accounts" source_repair
    ON source_repair."id" = transfer."source_repair_account_id"
  JOIN "balance_ledger_repair_accounts" target_repair
    ON target_repair."id" = transfer."target_repair_account_id"
  JOIN "billing_accounts" target_account
    ON target_account."id" = transfer."target_billing_account_id"
  WHERE transfer."id" = NEW."transfer_repair_id";
  SELECT * INTO grant_row FROM "balance_grants" WHERE "id" = NEW."grant_id";
  SELECT * INTO funding_row FROM "balance_transactions"
  WHERE "id" = NEW."source_funding_transaction_id";
  SELECT * INTO order_row FROM "orders" WHERE "id" = grant_row."order_id";

  SELECT
    COALESCE(jsonb_agg(to_jsonb(allocation) ORDER BY allocation."id"), '[]'::JSONB),
    COUNT(*), COALESCE(SUM(allocation."amount_usd"), 0),
    COALESCE(SUM(allocation."recognized_revenue_usd"), 0),
    COALESCE(SUM(allocation."bonus_consumed_usd"), 0)
    INTO source_allocations, source_count, source_amount, source_paid, source_bonus
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."balance_grant_id" = NEW."grant_id"
    AND allocation."billing_account_id" = transfer_row."source_billing_account_id";
  SELECT
    COALESCE(jsonb_agg(to_jsonb(allocation) ORDER BY allocation."id"), '[]'::JSONB),
    COUNT(*), COALESCE(SUM(allocation."amount_usd"), 0),
    COALESCE(SUM(allocation."recognized_revenue_usd"), 0),
    COALESCE(SUM(allocation."bonus_consumed_usd"), 0)
    INTO target_allocations, target_count, target_amount, target_paid, target_bonus
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."balance_grant_id" = NEW."grant_id"
    AND allocation."billing_account_id" = transfer_row."target_billing_account_id";
  SELECT COUNT(*) INTO foreign_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."balance_grant_id" = NEW."grant_id"
    AND allocation."billing_account_id" NOT IN (
      transfer_row."source_billing_account_id", transfer_row."target_billing_account_id"
    );
  SELECT COUNT(*) INTO unsafe_invoice_count
  FROM "invoice_application_items" item
  JOIN "invoice_applications" application ON application."id" = item."application_id"
  WHERE item."order_id" = grant_row."order_id"
    AND (
      application."status"::TEXT <> 'FAILED'
      OR application."invoice_number" IS NOT NULL
      OR application."issue_date" IS NOT NULL
      OR application."due_date" IS NOT NULL
      OR application."issued_at" IS NOT NULL
      OR application."pdf_url" IS NOT NULL
      OR application."ofd_url" IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM "invoice_event_log" event
        WHERE event."application_id" = application."id"
          AND event."to_status"::TEXT IN ('ISSUED', 'VOIDED', 'RED_OFFSET')
      )
    );
  SELECT jsonb_build_object(
    'order', to_jsonb(order_row),
    'items', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(item) || jsonb_build_object(
          'application', to_jsonb(application),
          'events', COALESCE((
            SELECT jsonb_agg(to_jsonb(event) ORDER BY event."occurred_at", event."id")
            FROM "invoice_event_log" event
            WHERE event."application_id" = application."id"
          ), '[]'::JSONB)
        ) ORDER BY item."id"
      )
      FROM "invoice_application_items" item
      JOIN "invoice_applications" application ON application."id" = item."application_id"
      WHERE item."order_id" = grant_row."order_id"
    ), '[]'::JSONB)
  ) INTO current_invoice;
  SELECT COUNT(*) INTO expiry_count FROM "balance_grant_expiries"
  WHERE "balance_grant_id" = NEW."grant_id";
  SELECT COUNT(*) INTO refund_count FROM "balance_grant_refunds"
  WHERE "balance_grant_id" = NEW."grant_id";

  IF transfer_row."id" IS NULL
    OR transfer_row.run_status IS DISTINCT FROM 'RUNNING'
    OR transfer_row.source_repair_status IS DISTINCT FROM 'RUNNING'
    OR transfer_row.target_repair_status IS DISTINCT FROM 'RUNNING'
    OR grant_row."id" IS NULL
    OR funding_row."id" IS NULL
    OR to_jsonb(grant_row) IS DISTINCT FROM NEW."grant_snapshot"
    OR to_jsonb(funding_row) IS DISTINCT FROM NEW."funding_transaction_snapshot"
    OR source_allocations IS DISTINCT FROM NEW."source_allocations_snapshot"
    OR target_allocations IS DISTINCT FROM NEW."target_allocations_snapshot"
    OR current_invoice IS DISTINCT FROM NEW."invoice_evidence_snapshot"
    OR grant_row."billing_account_id" IS DISTINCT FROM transfer_row."target_billing_account_id"
    OR funding_row."billing_account_id" IS DISTINCT FROM transfer_row."source_billing_account_id"
    OR funding_row."type"::TEXT IS DISTINCT FROM 'RECHARGE'
    OR funding_row."amount_usd" <= 0
    OR funding_row."order_id" IS NULL
    OR funding_row."order_id" IS DISTINCT FROM grant_row."order_id"
    OR NOT "balance_enterprise_absorb_order_is_single_paid_grant"(
      grant_row."order_id", funding_row."id", grant_row."id"
    )
    OR funding_row."user_id" IS DISTINCT FROM grant_row."user_id"
    OR funding_row."tenant_id" IS DISTINCT FROM grant_row."tenant_id"
    OR funding_row."product_id" IS DISTINCT FROM grant_row."product_id"
    OR grant_row."source" IS DISTINCT FROM 'RECHARGE'
    OR grant_row."paid_amount_usd" IS DISTINCT FROM funding_row."amount_usd"
    OR grant_row."bonus_amount_usd" IS DISTINCT FROM 0
    OR grant_row."granted_amount_usd" IS DISTINCT FROM grant_row."paid_amount_usd"
    OR (grant_row."remaining_paid_amount_usd" IS NULL)
      IS DISTINCT FROM (grant_row."remaining_bonus_amount_usd" IS NULL)
    OR source_count IS DISTINCT FROM NEW."source_allocation_count"
    OR target_count IS DISTINCT FROM NEW."target_allocation_count"
    OR source_amount IS DISTINCT FROM NEW."source_consumed_amount_usd"
    OR source_paid IS DISTINCT FROM NEW."source_consumed_paid_usd"
    OR source_bonus IS DISTINCT FROM NEW."source_consumed_bonus_usd"
    OR target_amount IS DISTINCT FROM NEW."target_consumed_amount_usd"
    OR target_paid IS DISTINCT FROM NEW."target_consumed_paid_usd"
    OR target_bonus IS DISTINCT FROM NEW."target_consumed_bonus_usd"
    OR grant_row."granted_amount_usd" - source_amount
      IS DISTINCT FROM NEW."transferred_amount_usd"
    OR grant_row."remaining_amount_usd" + target_amount
      IS DISTINCT FROM NEW."transferred_amount_usd"
    OR (
      grant_row."remaining_paid_amount_usd" IS NOT NULL
      AND grant_row."remaining_paid_amount_usd" + target_paid
        IS DISTINCT FROM NEW."transferred_paid_usd"
    )
    OR (
      grant_row."remaining_bonus_amount_usd" IS NOT NULL
      AND grant_row."remaining_bonus_amount_usd" + target_bonus
        IS DISTINCT FROM NEW."transferred_bonus_usd"
    )
    OR foreign_count <> 0
    OR unsafe_invoice_count <> 0
    OR expiry_count <> 0 OR refund_count <> 0
    OR order_row."id" IS NULL
    OR order_row."billing_account_id" IS DISTINCT FROM transfer_row."source_billing_account_id"
    OR order_row."user_id" IS DISTINCT FROM funding_row."user_id"
    OR order_row."tenant_id" IS DISTINCT FROM funding_row."tenant_id"
    OR order_row."product_id" IS DISTINCT FROM funding_row."product_id"
    OR order_row."order_type"::TEXT IS DISTINCT FROM 'RECHARGE'
    OR order_row."status"::TEXT IS DISTINCT FROM 'COMPLETED'
    OR lower(btrim(order_row."currency")) IS DISTINCT FROM
      lower(btrim(transfer_row.target_account_currency))
    OR order_row."amount_cents"::NUMERIC / 100 IS DISTINCT FROM grant_row."paid_amount_usd"
    OR order_row."bonus_cents"::NUMERIC / 100 IS DISTINCT FROM grant_row."bonus_amount_usd"
    OR order_row."refunded_at" IS NOT NULL OR order_row."refund_amount_cents" IS NOT NULL
    OR order_row."paid_at" IS NULL OR order_row."completed_at" IS NULL
    OR order_row."created_at" > order_row."paid_at"
    OR funding_row."created_at" < order_row."paid_at"
    OR funding_row."created_at" > order_row."completed_at"
    OR grant_row."created_at" < order_row."paid_at"
    OR grant_row."created_at" > order_row."completed_at"
    OR grant_row."valid_from" > grant_row."created_at"
    OR grant_row."valid_from" < order_row."paid_at"
    OR grant_row."valid_from" > order_row."completed_at"
    OR (grant_row."expires_at" IS NOT NULL AND grant_row."expires_at" <= grant_row."valid_from")
    OR EXISTS (
      SELECT 1 FROM "balance_consumption_allocations" allocation
      WHERE allocation."balance_grant_id" = NEW."grant_id"
        AND allocation."billing_account_id" = transfer_row."source_billing_account_id"
        AND (
          allocation."source" <> 'BALANCE_GRANT'
          OR allocation."created_at" >= (
            transfer_row."out_transaction_snapshot"->>'created_at'
          )::TIMESTAMP(3)
        )
    )
    OR EXISTS (
      SELECT 1 FROM "balance_consumption_allocations" allocation
      WHERE allocation."balance_grant_id" = NEW."grant_id"
        AND allocation."billing_account_id" = transfer_row."target_billing_account_id"
        AND (
          allocation."source" <> 'BALANCE_GRANT'
          OR allocation."created_at" <= (
            transfer_row."in_transaction_snapshot"->>'created_at'
          )::TIMESTAMP(3)
        )
    )
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:enterprise-absorb-grant:' || transfer_row."run_id" || ':' || NEW."grant_id"
    )
  THEN
    RAISE EXCEPTION 'enterprise absorb grant proof invalid transfer=% grant=%',
      NEW."transfer_repair_id", NEW."grant_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_ledger_transfer_grants_insert_guard"
BEFORE INSERT ON "balance_ledger_account_transfer_grants"
FOR EACH ROW EXECUTE FUNCTION "validate_balance_enterprise_absorb_grant_insert"();

CREATE OR REPLACE FUNCTION "validate_balance_ledger_grant_creation_repair_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  transaction_row RECORD;
  idempotency_row RECORD;
  response JSONB;
  target_grant JSONB;
BEGIN
  SELECT "status" INTO run_status FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO transaction_row FROM "balance_transactions"
  WHERE "id" = NEW."balance_transaction_id";
  SELECT * INTO idempotency_row FROM "idempotency_keys"
  WHERE "key" = NEW."idempotency_key" AND "scope" = NEW."idempotency_scope";
  response := CASE
    WHEN idempotency_row."result" ? 'response' THEN idempotency_row."result"->'response'
    ELSE idempotency_row."result"
  END;
  target_grant := NEW."grant_snapshot";

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR account_row."type" IS DISTINCT FROM 'enterprise'
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR transaction_row."id" IS NULL
    OR transaction_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR transaction_row."type"::TEXT IS DISTINCT FROM 'ADJUST'
    OR transaction_row."amount_usd" <= 0
    OR transaction_row."order_id" IS NOT NULL
    OR transaction_row."operation_key" IS NOT NULL
    OR to_jsonb(transaction_row) IS DISTINCT FROM NEW."transaction_snapshot"
    OR idempotency_row."key" IS NULL
    OR idempotency_row."status" IS DISTINCT FROM 'COMMITTED'
    OR idempotency_row."user_id" IS DISTINCT FROM transaction_row."user_id"
    OR idempotency_row."created_at" > transaction_row."created_at"
    OR transaction_row."created_at" >= idempotency_row."expires_at"
    OR to_jsonb(idempotency_row) IS DISTINCT FROM NEW."idempotency_snapshot"
    OR NEW."idempotency_key" NOT LIKE
      'enterprise-recharge:' || NEW."billing_account_id" || ':%'
    OR response IS NULL
    OR response->>'id' IS DISTINCT FROM transaction_row."id"
    OR response->>'userId' IS DISTINCT FROM transaction_row."user_id"
    OR response->>'tenantId' IS DISTINCT FROM transaction_row."tenant_id"
    OR response->>'type' IS DISTINCT FROM 'ADJUST'
    OR COALESCE(response->>'productId', '') IS DISTINCT FROM
      COALESCE(transaction_row."product_id", '')
    OR (response->>'amountUsd')::NUMERIC IS DISTINCT FROM transaction_row."amount_usd"
    OR (response->>'balanceAfterUsd')::NUMERIC IS DISTINCT FROM
      transaction_row."balance_after_usd"
    OR response->>'description' IS DISTINCT FROM transaction_row."description"
    OR (response->>'createdAt')::TIMESTAMPTZ IS DISTINCT FROM
      transaction_row."created_at" AT TIME ZONE 'UTC'
    OR target_grant->>'id' IS DISTINCT FROM NEW."balance_grant_id"
    OR target_grant->>'user_id' IS DISTINCT FROM transaction_row."user_id"
    OR target_grant->>'tenant_id' IS DISTINCT FROM transaction_row."tenant_id"
    OR target_grant->>'billing_account_id' IS DISTINCT FROM NEW."billing_account_id"
    OR COALESCE(target_grant->>'product_id', '') IS DISTINCT FROM
      COALESCE(transaction_row."product_id", '')
    OR target_grant->>'order_id' IS NOT NULL
    OR target_grant->>'source' IS DISTINCT FROM 'RECHARGE'
    OR (target_grant->>'paid_amount_usd')::NUMERIC IS DISTINCT FROM
      transaction_row."amount_usd"
    OR (target_grant->>'bonus_amount_usd')::NUMERIC IS DISTINCT FROM 0
    OR (target_grant->>'granted_amount_usd')::NUMERIC IS DISTINCT FROM
      transaction_row."amount_usd"
    OR (target_grant->>'remaining_amount_usd')::NUMERIC IS DISTINCT FROM
      transaction_row."amount_usd"
    OR (target_grant->>'remaining_paid_amount_usd')::NUMERIC IS DISTINCT FROM
      transaction_row."amount_usd"
    OR (target_grant->>'remaining_bonus_amount_usd')::NUMERIC IS DISTINCT FROM 0
    OR (target_grant->>'discount_rate')::NUMERIC IS DISTINCT FROM 1
    OR (target_grant->>'valid_from')::TIMESTAMP(3) IS DISTINCT FROM
      transaction_row."created_at"
    OR (target_grant->>'created_at')::TIMESTAMP(3) IS DISTINCT FROM
      transaction_row."created_at"
    OR (target_grant->>'updated_at')::TIMESTAMP(3) IS DISTINCT FROM
      transaction_row."created_at"
    OR (target_grant->>'expires_at')::TIMESTAMP(3) IS DISTINCT FROM
      transaction_row."created_at" + INTERVAL '365 days'
    OR (target_grant->>'is_expired')::BOOLEAN
    OR EXISTS (
      SELECT 1 FROM "balance_grants" grant_row
      WHERE grant_row."id" = NEW."balance_grant_id"
    )
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:admin-recharge-grant:' || NEW."run_id" || ':'
      || NEW."balance_transaction_id"
    )
  THEN
    RAISE EXCEPTION 'legacy admin recharge grant proof invalid run=% tx=% grant=%',
      NEW."run_id", NEW."balance_transaction_id", NEW."balance_grant_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'legacy admin recharge grant proof contains invalid typed evidence tx=%',
      NEW."balance_transaction_id"
      USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_grant_creation_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_grant_creation_repairs"
FOR EACH ROW EXECUTE FUNCTION "validate_balance_ledger_grant_creation_repair_insert"();

CREATE OR REPLACE FUNCTION "guard_repair_admin_recharge_grant_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  proof RECORD;
BEGIN
  IF NEW."id" NOT LIKE 'repair-admin-recharge:%' THEN
    RETURN NEW;
  END IF;
  SELECT creation.*, repair."status" AS repair_status, run."status" AS run_status
    INTO proof
  FROM "balance_ledger_grant_creation_repairs" creation
  JOIN "balance_ledger_repair_accounts" repair
    ON repair."id" = creation."repair_account_id"
  JOIN "balance_ledger_repair_runs" run ON run."id" = creation."run_id"
  WHERE creation."balance_grant_id" = NEW."id";
  IF proof."id" IS NULL
    OR proof.repair_status IS DISTINCT FROM 'RUNNING'
    OR proof.run_status IS DISTINCT FROM 'RUNNING'
    OR proof."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR proof."grant_snapshot" IS DISTINCT FROM to_jsonb(NEW)
  THEN
    RAISE EXCEPTION 'reserved repair admin recharge grant lacks exact proof: %', NEW."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_grants_repair_admin_recharge_insert_guard"
BEFORE INSERT ON "balance_grants"
FOR EACH ROW EXECUTE FUNCTION "guard_repair_admin_recharge_grant_insert"();

CREATE OR REPLACE FUNCTION "validate_balance_ledger_grant_creation_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "balance_grants" grant_row
    WHERE grant_row."id" = NEW."balance_grant_id"
      AND grant_row."billing_account_id" = NEW."billing_account_id"
      AND to_jsonb(grant_row) = NEW."grant_snapshot"
  ) THEN
    RAISE EXCEPTION 'legacy admin recharge proof missing exact terminal grant: %',
      NEW."balance_grant_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_grant_creation_repairs_terminal_deferred"
AFTER INSERT ON "balance_ledger_grant_creation_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_balance_ledger_grant_creation_terminal"();

CREATE OR REPLACE FUNCTION "validate_balance_enterprise_absorb_grant_component_repair_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_grant JSONB;
  run_status TEXT;
  repair_row RECORD;
  account_status TEXT;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs" WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts" WHERE "id" = NEW."repair_account_id";
  SELECT "balance_grant_ledger_status" INTO account_status
  FROM "billing_accounts" WHERE "id" = NEW."billing_account_id";
  SELECT to_jsonb(grant_row) INTO current_grant
  FROM "balance_grants" grant_row
  WHERE grant_row."id" = NEW."grant_id"
    AND grant_row."billing_account_id" = NEW."billing_account_id";

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR account_status IS DISTINCT FROM 'LEGACY_DIRTY'
    OR current_grant IS NULL
    OR current_grant IS DISTINCT FROM NEW."before_snapshot"
    OR NOT EXISTS (
      SELECT 1
      FROM "balance_ledger_account_transfer_repairs" transfer_proof
      WHERE transfer_proof."run_id" = NEW."run_id"
        AND transfer_proof."target_repair_account_id" = NEW."repair_account_id"
        AND transfer_proof."target_billing_account_id" = NEW."billing_account_id"
    )
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:grant-components:' || NEW."run_id" || ':' || NEW."grant_id"
    )
    OR NEW."before_snapshot"->>'id' IS DISTINCT FROM NEW."grant_id"
    OR NEW."after_snapshot"->>'id' IS DISTINCT FROM NEW."grant_id"
    OR NEW."before_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR NEW."after_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR (NEW."before_snapshot" - ARRAY[
      'remaining_paid_amount_usd', 'remaining_bonus_amount_usd'
    ]) IS DISTINCT FROM (NEW."after_snapshot" - ARRAY[
      'remaining_paid_amount_usd', 'remaining_bonus_amount_usd'
    ])
    OR NEW."before_snapshot"->'remaining_paid_amount_usd' <> 'null'::JSONB
    OR NEW."before_snapshot"->'remaining_bonus_amount_usd' <> 'null'::JSONB
    OR NEW."after_snapshot"->'remaining_paid_amount_usd' = 'null'::JSONB
    OR NEW."after_snapshot"->'remaining_bonus_amount_usd' = 'null'::JSONB
    OR (NEW."after_snapshot"->>'remaining_paid_amount_usd')::NUMERIC < 0
    OR (NEW."after_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC < 0
    OR (NEW."after_snapshot"->>'remaining_paid_amount_usd')::NUMERIC
      + (NEW."after_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC
      IS DISTINCT FROM (NEW."after_snapshot"->>'remaining_amount_usd')::NUMERIC
    OR (NEW."after_snapshot"->>'remaining_paid_amount_usd')::NUMERIC
      > (NEW."after_snapshot"->>'paid_amount_usd')::NUMERIC
    OR (NEW."after_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC
      > (NEW."after_snapshot"->>'bonus_amount_usd')::NUMERIC
  THEN
    RAISE EXCEPTION 'enterprise absorb grant component repair audit invalid run=% grant=%',
      NEW."run_id", NEW."grant_id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'enterprise absorb grant component repair has invalid numeric evidence grant=%',
      NEW."grant_id" USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_grant_component_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_grant_component_repairs"
FOR EACH ROW EXECUTE FUNCTION "validate_balance_enterprise_absorb_grant_component_repair_insert"();

CREATE OR REPLACE FUNCTION "authorize_balance_enterprise_absorb_grant_component_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
BEGIN
  IF NEW."remaining_paid_amount_usd" IS NOT DISTINCT FROM OLD."remaining_paid_amount_usd"
    AND NEW."remaining_bonus_amount_usd" IS NOT DISTINCT FROM OLD."remaining_bonus_amount_usd"
  THEN
    RETURN NEW;
  END IF;
  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  IF EXISTS (
    SELECT 1 FROM "balance_ledger_account_transfer_repairs" transfer_proof
    WHERE transfer_proof."run_id" = active_run_id
      AND transfer_proof."target_billing_account_id" = OLD."billing_account_id"
  ) AND NOT EXISTS (
    SELECT 1
    FROM "balance_ledger_grant_component_repairs" component_repair
    JOIN "balance_ledger_repair_accounts" repair
      ON repair."id" = component_repair."repair_account_id"
    WHERE component_repair."run_id" = active_run_id
      AND component_repair."billing_account_id" = OLD."billing_account_id"
      AND component_repair."grant_id" = OLD."id"
      AND component_repair."before_snapshot" = to_jsonb(OLD)
      AND component_repair."after_snapshot" = to_jsonb(NEW)
      AND repair."status" = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'enterprise absorb grant component update lacks exact audit grant=%',
      OLD."id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_grants_enterprise_absorb_component_update_guard"
BEFORE UPDATE ON "balance_grants"
FOR EACH ROW EXECUTE FUNCTION "authorize_balance_enterprise_absorb_grant_component_update"();

CREATE OR REPLACE FUNCTION "validate_balance_enterprise_absorb_grant_component_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "balance_grants" grant_row
    JOIN "balance_ledger_repair_accounts" target_repair
      ON target_repair."id" = NEW."repair_account_id"
    JOIN "balance_ledger_account_transfer_repairs" transfer_proof
      ON transfer_proof."run_id" = NEW."run_id"
      AND transfer_proof."target_repair_account_id" = target_repair."id"
    JOIN "balance_ledger_repair_accounts" source_repair
      ON source_repair."id" = transfer_proof."source_repair_account_id"
    JOIN "billing_accounts" source_account
      ON source_account."id" = transfer_proof."source_billing_account_id"
    JOIN "billing_accounts" target_account
      ON target_account."id" = transfer_proof."target_billing_account_id"
    WHERE grant_row."id" = NEW."grant_id"
      AND grant_row."billing_account_id" = NEW."billing_account_id"
      AND to_jsonb(grant_row) = NEW."after_snapshot"
      AND target_repair."status" = 'APPLIED'
      AND source_repair."status" = 'APPLIED'
      AND source_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND target_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND source_account."balance_grant_ledger_hash" = source_repair."replay_hash"
      AND target_account."balance_grant_ledger_hash" = target_repair."replay_hash"
  ) THEN
    RAISE EXCEPTION 'enterprise absorb grant component repair lacks terminal pair proof grant=%',
      NEW."grant_id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_grant_component_repairs_terminal_deferred"
AFTER INSERT ON "balance_ledger_grant_component_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_balance_enterprise_absorb_grant_component_terminal"();

-- Finance reports may accept a historical cross-account allocation only when
-- the exact retired enterprise-absorb pair has reached its terminal repair
-- state.  This is deliberately a three-key predicate: callers cannot prove a
-- different allocation by supplying only a grant or account from a valid pair.
CREATE OR REPLACE FUNCTION "balance_allocation_has_enterprise_absorb_proof"(
  target_allocation_id TEXT,
  target_grant_id TEXT,
  allocation_account_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM "balance_consumption_allocations" allocation
    JOIN "balance_grants" grant_row
      ON grant_row."id" = allocation."balance_grant_id"
    JOIN "balance_ledger_account_transfer_grants" grant_proof
      ON grant_proof."grant_id" = grant_row."id"
    JOIN "balance_ledger_account_transfer_repairs" transfer_proof
      ON transfer_proof."id" = grant_proof."transfer_repair_id"
    JOIN "balance_ledger_repair_accounts" source_repair
      ON source_repair."id" = transfer_proof."source_repair_account_id"
    JOIN "balance_ledger_repair_accounts" target_repair
      ON target_repair."id" = transfer_proof."target_repair_account_id"
    JOIN "balance_ledger_repair_runs" repair_run
      ON repair_run."id" = transfer_proof."run_id"
    JOIN "billing_accounts" source_account
      ON source_account."id" = transfer_proof."source_billing_account_id"
    JOIN "billing_accounts" target_account
      ON target_account."id" = transfer_proof."target_billing_account_id"
    JOIN "balance_transactions" consume_transaction
      ON consume_transaction."id" = allocation."balance_transaction_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      grant_proof."source_allocations_snapshot"
    ) source_snapshot
    WHERE target_allocation_id IS NOT NULL
      AND target_grant_id IS NOT NULL
      AND allocation_account_id IS NOT NULL
      AND allocation."id" = target_allocation_id
      AND allocation."balance_grant_id" = target_grant_id
      AND allocation."billing_account_id" = allocation_account_id
      AND allocation."billing_account_id"
        = transfer_proof."source_billing_account_id"
      AND grant_row."billing_account_id"
        = transfer_proof."target_billing_account_id"
      AND transfer_proof."source_billing_account_id"
        <> transfer_proof."target_billing_account_id"
      AND allocation."source" = 'BALANCE_GRANT'
      AND source_snapshot->>'id' = allocation."id"
      AND source_snapshot->>'balance_grant_id' = grant_row."id"
      AND source_snapshot->>'billing_account_id'
        = transfer_proof."source_billing_account_id"
      AND (to_jsonb(allocation) - 'ledger_sequence')
        = (source_snapshot - 'ledger_sequence')
      AND (
        to_jsonb(allocation)->'ledger_sequence'
          IS NOT DISTINCT FROM source_snapshot->'ledger_sequence'
        OR EXISTS (
          SELECT 1
          FROM "balance_ledger_allocation_repairs" allocation_repair
          WHERE allocation_repair."run_id" = transfer_proof."run_id"
            AND allocation_repair."repair_account_id" = source_repair."id"
            AND allocation_repair."billing_account_id"
              = transfer_proof."source_billing_account_id"
            AND allocation_repair."allocation_id" = allocation."id"
            AND allocation_repair."operation_key" =
              'repair:allocation:' || transfer_proof."run_id" || ':' || allocation."id"
            AND allocation_repair."before_snapshot" = source_snapshot
            AND allocation_repair."after_snapshot" = to_jsonb(allocation)
        )
      )
      AND consume_transaction."billing_account_id"
        = transfer_proof."source_billing_account_id"
      AND consume_transaction."type"::TEXT = 'CONSUME'
      AND consume_transaction."created_at"
        < (transfer_proof."out_transaction_snapshot"->>'created_at')::TIMESTAMP(3)
      AND source_repair."run_id" = transfer_proof."run_id"
      AND target_repair."run_id" = transfer_proof."run_id"
      AND source_repair."billing_account_id"
        = transfer_proof."source_billing_account_id"
      AND target_repair."billing_account_id"
        = transfer_proof."target_billing_account_id"
      AND source_repair."status" = 'APPLIED'
      AND target_repair."status" = 'APPLIED'
      AND source_repair."replay_hash" IS NOT NULL
      AND target_repair."replay_hash" IS NOT NULL
      AND source_repair."after_snapshot"->>'repairKind'
        = 'ENTERPRISE_ABSORB_V1'
      AND target_repair."after_snapshot"->>'repairKind'
        = 'ENTERPRISE_ABSORB_V1'
      AND source_repair."after_snapshot"->'transfer'->>'outTransactionId'
        = transfer_proof."out_transaction_id"
      AND target_repair."after_snapshot"->'transfer'->>'inTransactionId'
        = transfer_proof."in_transaction_id"
      AND repair_run."status" IN ('RUNNING', 'COMPLETED')
      AND source_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND target_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND source_account."balance_grant_ledger_version" = 2
      AND target_account."balance_grant_ledger_version" = 2
      AND source_account."balance_grant_ledger_hash" = source_repair."replay_hash"
      AND target_account."balance_grant_ledger_hash" = target_repair."replay_hash"
      AND source_account."balance_grant_ledger_reconciled_at" IS NOT NULL
      AND target_account."balance_grant_ledger_reconciled_at" IS NOT NULL
      AND source_account."balance_grant_ledger_dirty_reason" IS NULL
      AND target_account."balance_grant_ledger_dirty_reason" IS NULL
  ), FALSE)
$$;

-- Internal grant-funding exception for the one legacy admin ADJUST that the
-- pair repair converts into a paid-only batch.  It is intentionally terminal:
-- a RUNNING proof cannot weaken normal clean-ledger funding validation.
CREATE OR REPLACE FUNCTION "balance_grant_has_enterprise_absorb_creation_proof"(
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM "balance_grants" grant_row
    JOIN "balance_ledger_grant_creation_repairs" creation
      ON creation."balance_grant_id" = grant_row."id"
    JOIN "balance_ledger_repair_accounts" target_repair
      ON target_repair."id" = creation."repair_account_id"
    JOIN "balance_ledger_account_transfer_repairs" transfer_proof
      ON transfer_proof."run_id" = creation."run_id"
      AND transfer_proof."target_repair_account_id" = target_repair."id"
      AND transfer_proof."target_billing_account_id" = creation."billing_account_id"
    JOIN "balance_ledger_repair_accounts" source_repair
      ON source_repair."id" = transfer_proof."source_repair_account_id"
    JOIN "billing_accounts" source_account
      ON source_account."id" = transfer_proof."source_billing_account_id"
    JOIN "billing_accounts" target_account
      ON target_account."id" = transfer_proof."target_billing_account_id"
    JOIN "balance_ledger_repair_runs" repair_run
      ON repair_run."id" = transfer_proof."run_id"
    WHERE target_grant_id IS NOT NULL
      AND grant_row."id" = target_grant_id
      AND creation."repair_kind" = 'LEGACY_ENTERPRISE_ADMIN_RECHARGE_V1'
      AND creation."billing_account_id" = grant_row."billing_account_id"
      AND creation."grant_snapshot" = to_jsonb(grant_row)
      AND target_repair."status" = 'APPLIED'
      AND source_repair."status" = 'APPLIED'
      AND repair_run."status" IN ('RUNNING', 'COMPLETED')
      AND source_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND target_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND source_account."balance_grant_ledger_version" = 2
      AND target_account."balance_grant_ledger_version" = 2
      AND source_account."balance_grant_ledger_hash" = source_repair."replay_hash"
      AND target_account."balance_grant_ledger_hash" = target_repair."replay_hash"
  ), FALSE)
$$;

CREATE OR REPLACE FUNCTION "balance_enterprise_absorb_transaction_snapshot_is_current"(
  target_transaction_id TEXT,
  original_snapshot JSONB,
  target_run_id TEXT,
  target_repair_account_id TEXT,
  target_billing_account_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM "balance_transactions" transaction_row
    WHERE transaction_row."id" = target_transaction_id
      AND transaction_row."billing_account_id" = target_billing_account_id
      AND (to_jsonb(transaction_row) - 'ledger_sequence')
        = (original_snapshot - 'ledger_sequence')
      AND (
        to_jsonb(transaction_row)->'ledger_sequence'
          IS NOT DISTINCT FROM original_snapshot->'ledger_sequence'
        OR EXISTS (
          SELECT 1
          FROM "balance_ledger_transaction_repairs" transaction_repair
          WHERE transaction_repair."run_id" = target_run_id
            AND transaction_repair."repair_account_id" = target_repair_account_id
            AND transaction_repair."billing_account_id" = target_billing_account_id
            AND transaction_repair."transaction_id" = transaction_row."id"
            AND transaction_repair."operation_key" =
              'repair:transaction-sequence:' || target_run_id || ':' || transaction_row."id"
            AND transaction_repair."before_snapshot" = original_snapshot
            AND transaction_repair."after_snapshot" = to_jsonb(transaction_row)
        )
      )
  ), FALSE)
$$;

CREATE OR REPLACE FUNCTION "balance_enterprise_absorb_allocation_snapshot_is_current"(
  target_allocation_id TEXT,
  original_snapshot JSONB,
  target_run_id TEXT,
  target_repair_account_id TEXT,
  target_billing_account_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM "balance_consumption_allocations" allocation
    WHERE allocation."id" = target_allocation_id
      AND allocation."billing_account_id" = target_billing_account_id
      AND (to_jsonb(allocation) - 'ledger_sequence')
        = (original_snapshot - 'ledger_sequence')
      AND (
        to_jsonb(allocation)->'ledger_sequence'
          IS NOT DISTINCT FROM original_snapshot->'ledger_sequence'
        OR EXISTS (
          SELECT 1
          FROM "balance_ledger_allocation_repairs" allocation_repair
          WHERE allocation_repair."run_id" = target_run_id
            AND allocation_repair."repair_account_id" = target_repair_account_id
            AND allocation_repair."billing_account_id" = target_billing_account_id
            AND allocation_repair."allocation_id" = allocation."id"
            AND allocation_repair."operation_key" =
              'repair:allocation:' || target_run_id || ':' || allocation."id"
            AND allocation_repair."before_snapshot" = original_snapshot
            AND allocation_repair."after_snapshot" = to_jsonb(allocation)
        )
      )
  ), FALSE)
$$;

CREATE OR REPLACE FUNCTION "assert_balance_enterprise_absorb_pair_repair"(
  target_run_id TEXT,
  source_account_id TEXT,
  target_account_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  transfer_proof RECORD;
  source_repair RECORD;
  target_repair RECORD;
  source_account RECORD;
  target_account RECORD;
  source_wallet NUMERIC;
  target_wallet NUMERIC;
  source_path TEXT[];
  target_path TEXT[];
  financial_now_setting TEXT;
  financial_now TIMESTAMP(3);
  pair_is_terminal BOOLEAN;
  proof_count BIGINT;
  repair_account_count BIGINT;
  grant_proof_count BIGINT;
  grant_proof_total NUMERIC;
  invalid_transfer_grant_count BIGINT;
  incomplete_transfer_grant_count BIGINT;
  invalid_cross_allocation_count BIGINT;
  invalid_transaction_count BIGINT;
  invalid_funding_count BIGINT;
  invalid_grant_count BIGINT;
  invalid_allocation_count BIGINT;
  invalid_consume_count BIGINT;
  invalid_settlement_count BIGINT;
  invalid_cross_account_settlement_count BIGINT;
  invalid_grant_conservation_count BIGINT;
  active_source_grants NUMERIC;
  active_target_grants NUMERIC;
  source_open_debt NUMERIC;
  target_open_debt NUMERIC;
  source_tail_id TEXT;
  target_tail_id TEXT;
  source_tail_balance NUMERIC;
  target_tail_balance NUMERIC;
  source_transaction_repairs BIGINT;
  target_transaction_repairs BIGINT;
  source_allocation_repairs BIGINT;
  target_allocation_repairs BIGINT;
  creation_proof_count BIGINT;
  invalid_creation_proof_count BIGINT;
  source_grant_component_repairs BIGINT;
  target_grant_component_repairs BIGINT;
  invalid_grant_component_repair_count BIGINT;
BEGIN
  IF target_run_id IS NULL
    OR source_account_id IS NULL
    OR target_account_id IS NULL
    OR source_account_id = target_account_id
  THEN
    RAISE EXCEPTION 'enterprise absorb pair assertion requires one exact run/source/target tuple'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO proof_count
  FROM "balance_ledger_account_transfer_repairs" proof
  WHERE proof."run_id" = target_run_id
    AND proof."source_billing_account_id" = source_account_id
    AND proof."target_billing_account_id" = target_account_id;
  SELECT proof.*, repair_run."status" AS run_status
    INTO transfer_proof
  FROM "balance_ledger_account_transfer_repairs" proof
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = proof."run_id"
  WHERE proof."run_id" = target_run_id
    AND proof."source_billing_account_id" = source_account_id
    AND proof."target_billing_account_id" = target_account_id;
  SELECT * INTO source_repair
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = transfer_proof."source_repair_account_id";
  SELECT * INTO target_repair
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = transfer_proof."target_repair_account_id";
  SELECT account.*, wallet."balance_usd" AS wallet_balance
    INTO source_account
  FROM "billing_accounts" account
  JOIN "account_wallets" wallet ON wallet."billing_account_id" = account."id"
  WHERE account."id" = source_account_id;
  SELECT account.*, wallet."balance_usd" AS wallet_balance
    INTO target_account
  FROM "billing_accounts" account
  JOIN "account_wallets" wallet ON wallet."billing_account_id" = account."id"
  WHERE account."id" = target_account_id;
  SELECT COUNT(*) INTO repair_account_count
  FROM "balance_ledger_repair_accounts"
  WHERE "run_id" = target_run_id;

  IF proof_count <> 1
    OR transfer_proof."id" IS NULL
    OR transfer_proof.run_status NOT IN ('RUNNING', 'COMPLETED')
    OR repair_account_count <> 2
    OR source_repair."id" IS NULL
    OR target_repair."id" IS NULL
    OR source_repair."run_id" IS DISTINCT FROM target_run_id
    OR target_repair."run_id" IS DISTINCT FROM target_run_id
    OR source_repair."billing_account_id" IS DISTINCT FROM source_account_id
    OR target_repair."billing_account_id" IS DISTINCT FROM target_account_id
    OR source_account."id" IS NULL
    OR target_account."id" IS NULL
    OR source_account."type" IS DISTINCT FROM 'personal'
    OR target_account."type" IS DISTINCT FROM 'enterprise'
    OR source_account."status" IS DISTINCT FROM 'active'
    OR target_account."status" IS DISTINCT FROM 'active'
    OR source_account."owner_user_id" IS NULL
    OR source_account."owner_user_id" IS DISTINCT FROM target_account."owner_user_id"
  THEN
    RAISE EXCEPTION 'enterprise absorb pair identity invalid run=% source=% target=%',
      target_run_id, source_account_id, target_account_id
      USING ERRCODE = '23514';
  END IF;

  pair_is_terminal := source_account."balance_grant_ledger_status" = 'RECONCILED_V2'
    OR target_account."balance_grant_ledger_status" = 'RECONCILED_V2'
    OR source_repair."status" = 'APPLIED'
    OR target_repair."status" = 'APPLIED';
  IF pair_is_terminal THEN
    IF source_account."balance_grant_ledger_status" IS DISTINCT FROM 'RECONCILED_V2'
      OR target_account."balance_grant_ledger_status" IS DISTINCT FROM 'RECONCILED_V2'
      OR source_repair."status" IS DISTINCT FROM 'APPLIED'
      OR target_repair."status" IS DISTINCT FROM 'APPLIED'
      OR source_account."balance_grant_ledger_version" IS DISTINCT FROM 2
      OR target_account."balance_grant_ledger_version" IS DISTINCT FROM 2
      OR source_account."balance_grant_ledger_hash" IS DISTINCT FROM source_repair."replay_hash"
      OR target_account."balance_grant_ledger_hash" IS DISTINCT FROM target_repair."replay_hash"
      OR source_account."balance_grant_ledger_reconciled_at" IS NULL
      OR target_account."balance_grant_ledger_reconciled_at" IS NULL
      OR source_account."balance_grant_ledger_dirty_reason" IS NOT NULL
      OR target_account."balance_grant_ledger_dirty_reason" IS NOT NULL
      OR source_repair."after_snapshot" IS NULL
      OR target_repair."after_snapshot" IS NULL
      OR source_repair."after_snapshot"->>'repairKind'
        IS DISTINCT FROM 'ENTERPRISE_ABSORB_V1'
      OR target_repair."after_snapshot"->>'repairKind'
        IS DISTINCT FROM 'ENTERPRISE_ABSORB_V1'
      OR source_repair."after_snapshot"->'transfer'->>'outTransactionId'
        IS DISTINCT FROM transfer_proof."out_transaction_id"
      OR source_repair."after_snapshot"->'transfer'->>'inTransactionId'
        IS DISTINCT FROM transfer_proof."in_transaction_id"
      OR target_repair."after_snapshot"->'transfer'->>'outTransactionId'
        IS DISTINCT FROM transfer_proof."out_transaction_id"
      OR target_repair."after_snapshot"->'transfer'->>'inTransactionId'
        IS DISTINCT FROM transfer_proof."in_transaction_id"
      OR source_repair."after_snapshot"->>'replayHash'
        IS DISTINCT FROM source_repair."replay_hash"
      OR target_repair."after_snapshot"->>'replayHash'
        IS DISTINCT FROM target_repair."replay_hash"
      OR ((source_repair."after_snapshot"->>'reconciledAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC')::TIMESTAMP(3)
        IS DISTINCT FROM source_account."balance_grant_ledger_reconciled_at"
      OR ((target_repair."after_snapshot"->>'reconciledAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC')::TIMESTAMP(3)
        IS DISTINCT FROM target_account."balance_grant_ledger_reconciled_at"
    THEN
      RAISE EXCEPTION 'enterprise absorb terminal pair marker/audit mismatch run=%', target_run_id
        USING ERRCODE = '23514';
    END IF;
  ELSIF transfer_proof.run_status IS DISTINCT FROM 'RUNNING'
    OR source_account."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR target_account."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR source_repair."status" IS DISTINCT FROM 'RUNNING'
    OR target_repair."status" IS DISTINCT FROM 'RUNNING'
  THEN
    RAISE EXCEPTION 'enterprise absorb pair has a partial repair state run=%', target_run_id
      USING ERRCODE = '23514';
  END IF;

  IF NOT "balance_enterprise_absorb_transaction_snapshot_is_current"(
      transfer_proof."out_transaction_id",
      transfer_proof."out_transaction_snapshot",
      target_run_id,
      source_repair."id",
      source_account_id
    )
    OR NOT "balance_enterprise_absorb_transaction_snapshot_is_current"(
      transfer_proof."in_transaction_id",
      transfer_proof."in_transaction_snapshot",
      target_run_id,
      target_repair."id",
      target_account_id
    )
  THEN
    RAISE EXCEPTION 'enterprise absorb reciprocal transaction proof changed run=%', target_run_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(link."transferred_amount_usd"), 0)
    INTO grant_proof_count, grant_proof_total
  FROM "balance_ledger_account_transfer_grants" link
  WHERE link."transfer_repair_id" = transfer_proof."id";
  IF grant_proof_count = 0
    OR grant_proof_total IS DISTINCT FROM transfer_proof."amount_usd"
  THEN
    RAISE EXCEPTION 'enterprise absorb transferred grant aggregate mismatch run=% count=% amount=%/%',
      target_run_id, grant_proof_count, grant_proof_total, transfer_proof."amount_usd"
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_transfer_grant_count
  FROM "balance_ledger_account_transfer_grants" link
  JOIN "balance_grants" grant_row ON grant_row."id" = link."grant_id"
  JOIN "balance_transactions" funding
    ON funding."id" = link."source_funding_transaction_id"
  LEFT JOIN "orders" order_row ON order_row."id" = grant_row."order_id"
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'order', CASE WHEN order_row."id" IS NULL THEN NULL ELSE to_jsonb(order_row) END,
      'items', COALESCE((
        SELECT jsonb_agg(
          to_jsonb(item) || jsonb_build_object(
            'application', to_jsonb(application),
            'events', COALESCE((
              SELECT jsonb_agg(to_jsonb(event) ORDER BY event."occurred_at", event."id")
              FROM "invoice_event_log" event
              WHERE event."application_id" = application."id"
            ), '[]'::JSONB)
          ) ORDER BY item."id"
        )
        FROM "invoice_application_items" item
        JOIN "invoice_applications" application
          ON application."id" = item."application_id"
        WHERE item."order_id" = grant_row."order_id"
      ), '[]'::JSONB)
    ) AS current_snapshot
  ) invoice_state ON TRUE
  WHERE link."transfer_repair_id" = transfer_proof."id"
    AND (
      (to_jsonb(grant_row) - ARRAY[
        'remaining_paid_amount_usd', 'remaining_bonus_amount_usd'
      ]) IS DISTINCT FROM (link."grant_snapshot" - ARRAY[
        'remaining_paid_amount_usd', 'remaining_bonus_amount_usd'
      ])
      OR (
        to_jsonb(grant_row) IS DISTINCT FROM link."grant_snapshot"
        AND NOT EXISTS (
          SELECT 1
          FROM "balance_ledger_grant_component_repairs" component_repair
          WHERE component_repair."run_id" = target_run_id
            AND component_repair."repair_account_id" = target_repair."id"
            AND component_repair."billing_account_id" = target_account_id
            AND component_repair."grant_id" = grant_row."id"
            AND component_repair."before_snapshot" = link."grant_snapshot"
            AND component_repair."after_snapshot" = to_jsonb(grant_row)
        )
      )
      OR invoice_state.current_snapshot IS DISTINCT FROM link."invoice_evidence_snapshot"
      OR grant_row."billing_account_id" IS DISTINCT FROM target_account_id
      OR grant_row."source" IS DISTINCT FROM 'RECHARGE'
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM 0
      OR grant_row."paid_amount_usd" IS DISTINCT FROM grant_row."granted_amount_usd"
      OR NOT "balance_enterprise_absorb_transaction_snapshot_is_current"(
        funding."id", link."funding_transaction_snapshot", target_run_id,
        source_repair."id", source_account_id
      )
      OR funding."billing_account_id" IS DISTINCT FROM source_account_id
      OR funding."type"::TEXT IS DISTINCT FROM 'RECHARGE'
      OR funding."amount_usd" IS DISTINCT FROM grant_row."paid_amount_usd"
      OR NOT "balance_enterprise_absorb_order_is_single_paid_grant"(
        grant_row."order_id", funding."id", grant_row."id"
      )
      OR grant_row."valid_from" > grant_row."created_at"
      OR link."transferred_bonus_usd" IS DISTINCT FROM 0
      OR link."source_consumed_bonus_usd" IS DISTINCT FROM 0
      OR link."target_consumed_bonus_usd" IS DISTINCT FROM 0
      OR link."transferred_amount_usd" IS DISTINCT FROM link."transferred_paid_usd"
      OR grant_row."granted_amount_usd" - link."source_consumed_amount_usd"
        IS DISTINCT FROM link."transferred_amount_usd"
      OR grant_row."remaining_amount_usd" + link."target_consumed_amount_usd"
        IS DISTINCT FROM link."transferred_amount_usd"
      OR grant_row."remaining_paid_amount_usd" + link."target_consumed_paid_usd"
        IS DISTINCT FROM link."transferred_paid_usd"
      OR grant_row."remaining_bonus_amount_usd" + link."target_consumed_bonus_usd"
        IS DISTINCT FROM link."transferred_bonus_usd"
      OR jsonb_array_length(link."source_allocations_snapshot")
        IS DISTINCT FROM link."source_allocation_count"::INTEGER
      OR jsonb_array_length(link."target_allocations_snapshot")
        IS DISTINCT FROM link."target_allocation_count"::INTEGER
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(link."source_allocations_snapshot") snapshot
        WHERE NOT "balance_enterprise_absorb_allocation_snapshot_is_current"(
          snapshot->>'id', snapshot, target_run_id, source_repair."id", source_account_id
        )
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(link."target_allocations_snapshot") snapshot
        WHERE NOT "balance_enterprise_absorb_allocation_snapshot_is_current"(
          snapshot->>'id', snapshot, target_run_id, target_repair."id", target_account_id
        )
      )
      OR (SELECT COUNT(*) FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = source_account_id)
        IS DISTINCT FROM link."source_allocation_count"
      OR (SELECT COUNT(*) FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = target_account_id)
        IS DISTINCT FROM link."target_allocation_count"
      OR (SELECT COALESCE(SUM(allocation."amount_usd"), 0)
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = source_account_id)
        IS DISTINCT FROM link."source_consumed_amount_usd"
      OR (SELECT COALESCE(SUM(allocation."recognized_revenue_usd"), 0)
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = source_account_id)
        IS DISTINCT FROM link."source_consumed_paid_usd"
      OR (SELECT COALESCE(SUM(allocation."bonus_consumed_usd"), 0)
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = source_account_id)
        IS DISTINCT FROM link."source_consumed_bonus_usd"
      OR (SELECT COALESCE(SUM(allocation."amount_usd"), 0)
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = target_account_id)
        IS DISTINCT FROM link."target_consumed_amount_usd"
      OR (SELECT COALESCE(SUM(allocation."recognized_revenue_usd"), 0)
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = target_account_id)
        IS DISTINCT FROM link."target_consumed_paid_usd"
      OR (SELECT COALESCE(SUM(allocation."bonus_consumed_usd"), 0)
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = link."grant_id"
            AND allocation."billing_account_id" = target_account_id)
        IS DISTINCT FROM link."target_consumed_bonus_usd"
      OR EXISTS (
        SELECT 1 FROM "balance_consumption_allocations" allocation
        WHERE allocation."balance_grant_id" = link."grant_id"
          AND allocation."billing_account_id" NOT IN (source_account_id, target_account_id)
      )
    );
  IF invalid_transfer_grant_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb transferred grant proof invalid run=% count=%',
      target_run_id, invalid_transfer_grant_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO incomplete_transfer_grant_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id
    AND EXISTS (
      SELECT 1 FROM "balance_transactions" funding
      WHERE funding."billing_account_id" = source_account_id
        AND funding."order_id" IS NOT NULL
        AND funding."order_id" = grant_row."order_id"
        AND funding."type"::TEXT = 'RECHARGE'
        AND funding."amount_usd" > 0
    )
    AND NOT EXISTS (
      SELECT 1 FROM "balance_ledger_account_transfer_grants" link
      WHERE link."transfer_repair_id" = transfer_proof."id"
        AND link."grant_id" = grant_row."id"
    );
  SELECT COUNT(*) INTO invalid_cross_allocation_count
  FROM "balance_consumption_allocations" allocation
  JOIN "balance_grants" grant_row ON grant_row."id" = allocation."balance_grant_id"
  WHERE allocation."billing_account_id" IS DISTINCT FROM grant_row."billing_account_id"
    AND (
      allocation."billing_account_id" IN (source_account_id, target_account_id)
      OR grant_row."billing_account_id" IN (source_account_id, target_account_id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_ledger_account_transfer_grants" link
      WHERE link."transfer_repair_id" = transfer_proof."id"
        AND link."grant_id" = grant_row."id"
        AND allocation."billing_account_id" = source_account_id
        AND grant_row."billing_account_id" = target_account_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(link."source_allocations_snapshot") snapshot
          WHERE snapshot->>'id' = allocation."id"
            AND "balance_enterprise_absorb_allocation_snapshot_is_current"(
              allocation."id", snapshot, target_run_id,
              source_repair."id", source_account_id
            )
        )
    );
  SELECT invalid_cross_allocation_count + COUNT(*)
    INTO invalid_cross_allocation_count
  FROM "balance_consumption_allocations" allocation
  JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = allocation."balance_transaction_id"
  WHERE transaction_row."billing_account_id" IN (source_account_id, target_account_id)
    AND allocation."billing_account_id"
      IS DISTINCT FROM transaction_row."billing_account_id";
  IF incomplete_transfer_grant_count <> 0 OR invalid_cross_allocation_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb grant/allocation coverage incomplete run=% grant=% allocation=%',
      target_run_id, incomplete_transfer_grant_count, invalid_cross_allocation_count
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE creation."billing_account_id" IS DISTINCT FROM target_account_id
      OR creation."repair_account_id" IS DISTINCT FROM target_repair."id"
      OR creation."repair_kind" IS DISTINCT FROM 'LEGACY_ENTERPRISE_ADMIN_RECHARGE_V1'
      OR grant_row."id" IS NULL
      OR creation."grant_snapshot" IS DISTINCT FROM to_jsonb(grant_row)
      OR transaction_row."id" IS NULL
      OR NOT "balance_enterprise_absorb_transaction_snapshot_is_current"(
        transaction_row."id", creation."transaction_snapshot", target_run_id,
        target_repair."id", target_account_id
      )
      OR transaction_row."billing_account_id" IS DISTINCT FROM target_account_id
      OR transaction_row."type"::TEXT IS DISTINCT FROM 'ADJUST'
      OR transaction_row."amount_usd" <= 0
      OR grant_row."source" IS DISTINCT FROM 'RECHARGE'
      OR grant_row."paid_amount_usd" IS DISTINCT FROM transaction_row."amount_usd"
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM 0
      OR grant_row."remaining_amount_usd" IS DISTINCT FROM grant_row."granted_amount_usd"
  )
    INTO creation_proof_count, invalid_creation_proof_count
  FROM "balance_ledger_grant_creation_repairs" creation
  LEFT JOIN "balance_grants" grant_row ON grant_row."id" = creation."balance_grant_id"
  LEFT JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = creation."balance_transaction_id"
  WHERE creation."run_id" = target_run_id;
  IF creation_proof_count = 0 OR invalid_creation_proof_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb admin grant creation proof invalid run=% count=% invalid=%',
      target_run_id, creation_proof_count, invalid_creation_proof_count
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE component_repair."billing_account_id" = source_account_id),
    COUNT(*) FILTER (WHERE component_repair."billing_account_id" = target_account_id),
    COUNT(*) FILTER (WHERE
      component_repair."billing_account_id" NOT IN (source_account_id, target_account_id)
      OR component_repair."repair_account_id" IS DISTINCT FROM CASE
        WHEN component_repair."billing_account_id" = source_account_id
          THEN source_repair."id" ELSE target_repair."id" END
      OR component_repair."operation_key" IS DISTINCT FROM (
        'repair:grant-components:' || target_run_id || ':' || component_repair."grant_id"
      )
      OR grant_row."id" IS NULL
      OR component_repair."after_snapshot" IS DISTINCT FROM to_jsonb(grant_row)
      OR (component_repair."before_snapshot" - ARRAY[
        'remaining_paid_amount_usd', 'remaining_bonus_amount_usd'
      ]) IS DISTINCT FROM (component_repair."after_snapshot" - ARRAY[
        'remaining_paid_amount_usd', 'remaining_bonus_amount_usd'
      ])
      OR component_repair."before_snapshot"->'remaining_paid_amount_usd' <> 'null'::JSONB
      OR component_repair."before_snapshot"->'remaining_bonus_amount_usd' <> 'null'::JSONB
      OR component_repair."after_snapshot"->'remaining_paid_amount_usd' = 'null'::JSONB
      OR component_repair."after_snapshot"->'remaining_bonus_amount_usd' = 'null'::JSONB
    )
    INTO source_grant_component_repairs, target_grant_component_repairs,
      invalid_grant_component_repair_count
  FROM "balance_ledger_grant_component_repairs" component_repair
  LEFT JOIN "balance_grants" grant_row ON grant_row."id" = component_repair."grant_id"
  WHERE component_repair."run_id" = target_run_id;
  IF invalid_grant_component_repair_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb grant component audit invalid run=% count=%',
      target_run_id, invalid_grant_component_repair_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" IN (source_account_id, target_account_id)
    AND (
      transaction_row."ledger_sequence" IS NULL
      OR transaction_row."ledger_sequence" = 0
      OR transaction_row."type"::TEXT NOT IN ('RECHARGE', 'CONSUME', 'ADJUST')
      OR (transaction_row."type"::TEXT = 'CONSUME' AND transaction_row."amount_usd" >= 0)
      OR (transaction_row."type"::TEXT = 'RECHARGE' AND transaction_row."amount_usd" <= 0)
      OR (
        transaction_row."type"::TEXT = 'ADJUST'
        AND transaction_row."amount_usd" <= 0
        AND transaction_row."id" <> transfer_proof."out_transaction_id"
      )
      OR (
        transaction_row."id" = transfer_proof."out_transaction_id"
        AND (
          transaction_row."billing_account_id" <> source_account_id
          OR transaction_row."amount_usd" <> -transfer_proof."amount_usd"
        )
      )
      OR (
        transaction_row."id" = transfer_proof."in_transaction_id"
        AND (
          transaction_row."billing_account_id" <> target_account_id
          OR transaction_row."amount_usd" <> transfer_proof."amount_usd"
        )
      )
    );
  IF invalid_transaction_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb transaction set invalid run=% count=%',
      target_run_id, invalid_transaction_count USING ERRCODE = '23514';
  END IF;

  WITH pair_positive AS (
    SELECT transaction_row.*, account."type" AS account_type
    FROM "balance_transactions" transaction_row
    JOIN "billing_accounts" account ON account."id" = transaction_row."billing_account_id"
    WHERE transaction_row."billing_account_id" IN (source_account_id, target_account_id)
      AND transaction_row."amount_usd" > 0
  ), candidate_counts AS (
    SELECT funding."id", COUNT(candidate.funding_id) AS candidate_count
    FROM pair_positive funding
    LEFT JOIN LATERAL "balance_funding_candidates"(
      funding."billing_account_id", funding.account_type
    ) candidate ON candidate.funding_id = funding."id"
    GROUP BY funding."id"
  )
  SELECT COUNT(*) INTO invalid_funding_count
  FROM pair_positive funding
  JOIN candidate_counts cardinality ON cardinality."id" = funding."id"
  WHERE funding."id" <> transfer_proof."in_transaction_id"
    AND NOT EXISTS (
      SELECT 1 FROM "balance_ledger_account_transfer_grants" link
      WHERE link."transfer_repair_id" = transfer_proof."id"
        AND link."source_funding_transaction_id" = funding."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "balance_ledger_grant_creation_repairs" creation
      WHERE creation."run_id" = target_run_id
        AND creation."balance_transaction_id" = funding."id"
    )
    AND cardinality.candidate_count <> 1;
  SELECT invalid_funding_count + COUNT(*) INTO invalid_funding_count
  FROM "balance_grants" grant_row
  JOIN "billing_accounts" account
    ON account."id" = grant_row."billing_account_id"
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(funding."amount_usd") FILTER (WHERE candidate.nature = 'PAID'), 0)
        AS paid_usd,
      COALESCE(SUM(funding."amount_usd") FILTER (WHERE candidate.nature = 'BONUS'), 0)
        AS bonus_usd
    FROM "balance_funding_candidates"(account."id", account."type") candidate
    JOIN "balance_transactions" funding ON funding."id" = candidate.funding_id
    WHERE candidate.grant_id = grant_row."id"
  ) funding_aggregate ON TRUE
  WHERE grant_row."billing_account_id" IN (source_account_id, target_account_id)
    AND NOT EXISTS (
      SELECT 1 FROM "balance_ledger_account_transfer_grants" link
      WHERE link."transfer_repair_id" = transfer_proof."id"
        AND link."grant_id" = grant_row."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "balance_ledger_grant_creation_repairs" creation
      WHERE creation."run_id" = target_run_id
        AND creation."balance_grant_id" = grant_row."id"
    )
    AND (
      grant_row."paid_amount_usd" IS DISTINCT FROM funding_aggregate.paid_usd
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM funding_aggregate.bonus_usd
    );
  IF invalid_funding_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb positive funding classifier invalid run=% count=%',
      target_run_id, invalid_funding_count USING ERRCODE = '23514';
  END IF;

  financial_now_setting := current_setting('billing.balance_financial_now', TRUE);
  IF financial_now_setting IS NULL OR btrim(financial_now_setting) = '' THEN
    RAISE EXCEPTION 'enterprise absorb pair assertion lacks database financial clock run=%',
      target_run_id USING ERRCODE = '23514';
  END IF;
  financial_now := (financial_now_setting::TIMESTAMPTZ AT TIME ZONE 'UTC')::TIMESTAMP(3);

  SELECT COUNT(*) INTO invalid_grant_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" IN (source_account_id, target_account_id)
    AND (
      grant_row."paid_amount_usd" < 0
      OR grant_row."bonus_amount_usd" < 0
      OR grant_row."granted_amount_usd" <= 0
      OR grant_row."paid_amount_usd" + grant_row."bonus_amount_usd"
        <> grant_row."granted_amount_usd"
      OR grant_row."discount_rate" IS DISTINCT FROM ROUND(
        grant_row."paid_amount_usd" / grant_row."granted_amount_usd", 12
      )
      OR grant_row."remaining_amount_usd" < 0
      OR grant_row."remaining_paid_amount_usd" IS NULL
      OR grant_row."remaining_bonus_amount_usd" IS NULL
      OR grant_row."remaining_paid_amount_usd" < 0
      OR grant_row."remaining_bonus_amount_usd" < 0
      OR grant_row."remaining_amount_usd" <>
        grant_row."remaining_paid_amount_usd" + grant_row."remaining_bonus_amount_usd"
      OR grant_row."remaining_paid_amount_usd" > grant_row."paid_amount_usd"
      OR grant_row."remaining_bonus_amount_usd" > grant_row."bonus_amount_usd"
      OR grant_row."valid_from" > grant_row."created_at"
      OR (grant_row."expires_at" IS NOT NULL
        AND grant_row."expires_at" <= grant_row."valid_from")
      OR grant_row."is_expired"
      OR (grant_row."remaining_amount_usd" > 0
        AND grant_row."expires_at" IS NOT NULL
        AND grant_row."expires_at" <= financial_now)
    );
  IF invalid_grant_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb grant state invalid run=% count=%',
      target_run_id, invalid_grant_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_allocation_count
  FROM "balance_consumption_allocations" allocation
  LEFT JOIN "balance_transactions" consume_transaction
    ON consume_transaction."id" = allocation."balance_transaction_id"
  LEFT JOIN "balance_grants" grant_row ON grant_row."id" = allocation."balance_grant_id"
  WHERE allocation."billing_account_id" IN (source_account_id, target_account_id)
    AND (
      allocation."ledger_sequence" IS NULL
      OR allocation."ledger_sequence" = 0
      OR allocation."amount_usd" <= 0
      OR consume_transaction."id" IS NULL
      OR consume_transaction."billing_account_id" IS DISTINCT FROM allocation."billing_account_id"
      OR consume_transaction."type"::TEXT IS DISTINCT FROM 'CONSUME'
      OR allocation."user_id" IS DISTINCT FROM consume_transaction."user_id"
      OR allocation."tenant_id" IS DISTINCT FROM consume_transaction."tenant_id"
      OR allocation."product_id" IS DISTINCT FROM consume_transaction."product_id"
      OR allocation."token_usage_id" IS DISTINCT FROM consume_transaction."token_usage_id"
      OR (
        allocation."source" = 'BALANCE_GRANT'
        AND (
          grant_row."id" IS NULL
          OR (
            grant_row."billing_account_id" IS DISTINCT FROM allocation."billing_account_id"
            AND NOT EXISTS (
              SELECT 1
              FROM "balance_ledger_account_transfer_grants" link
              WHERE link."transfer_repair_id" = transfer_proof."id"
                AND link."grant_id" = grant_row."id"
                AND allocation."billing_account_id" = source_account_id
                AND grant_row."billing_account_id" = target_account_id
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(link."source_allocations_snapshot") snapshot
                  WHERE snapshot->>'id' = allocation."id"
                    AND "balance_enterprise_absorb_allocation_snapshot_is_current"(
                      allocation."id", snapshot, target_run_id,
                      source_repair."id", source_account_id
                    )
                )
            )
          )
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."amount_usd"
          OR allocation."discount_rate" IS DISTINCT FROM ROUND(
            allocation."recognized_revenue_usd" / allocation."amount_usd", 12
          )
          OR allocation."settled_usd" <> 0
          OR allocation."settled_at" IS NOT NULL
        )
      )
      OR (
        allocation."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT')
        AND (
          allocation."source" IS DISTINCT FROM CASE
            WHEN allocation."billing_account_id" = source_account_id
              THEN 'NEGATIVE_BALANCE' ELSE 'ENTERPRISE_CREDIT' END
          OR allocation."balance_grant_id" IS NOT NULL
          OR allocation."discount_rate" <> 0
          OR allocation."settled_usd" < 0
          OR allocation."settled_usd" > allocation."amount_usd"
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."settled_usd"
          OR (allocation."settled_usd" = allocation."amount_usd")
            IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
          OR allocation."settled_usd" IS DISTINCT FROM COALESCE((
            SELECT SUM(settlement."amount_usd")
            FROM "enterprise_credit_settlements" settlement
            WHERE settlement."allocation_id" = allocation."id"
              AND settlement."billing_account_id" = allocation."billing_account_id"
              AND settlement."trigger" = 'FUNDING'
              AND settlement."repair_run_id" IS NULL
          ), 0)
          OR allocation."recognized_revenue_usd" IS DISTINCT FROM COALESCE((
            SELECT SUM(settlement."paid_usd")
            FROM "enterprise_credit_settlements" settlement
            WHERE settlement."allocation_id" = allocation."id"
              AND settlement."billing_account_id" = allocation."billing_account_id"
              AND settlement."trigger" = 'FUNDING'
              AND settlement."repair_run_id" IS NULL
          ), 0)
          OR allocation."bonus_consumed_usd" IS DISTINCT FROM COALESCE((
            SELECT SUM(settlement."bonus_usd")
            FROM "enterprise_credit_settlements" settlement
            WHERE settlement."allocation_id" = allocation."id"
              AND settlement."billing_account_id" = allocation."billing_account_id"
              AND settlement."trigger" = 'FUNDING'
              AND settlement."repair_run_id" IS NULL
          ), 0)
        )
      )
      OR allocation."source" NOT IN (
        'BALANCE_GRANT',
        CASE WHEN allocation."billing_account_id" = source_account_id
          THEN 'NEGATIVE_BALANCE' ELSE 'ENTERPRISE_CREDIT' END
      )
    );
  IF invalid_allocation_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb allocation state invalid run=% count=%',
      target_run_id, invalid_allocation_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_consume_count
  FROM (
    SELECT transaction_row."id"
    FROM "balance_transactions" transaction_row
    LEFT JOIN "balance_consumption_allocations" allocation
      ON allocation."balance_transaction_id" = transaction_row."id"
      AND allocation."billing_account_id" = transaction_row."billing_account_id"
    WHERE transaction_row."billing_account_id" IN (source_account_id, target_account_id)
      AND transaction_row."type"::TEXT = 'CONSUME'
    GROUP BY transaction_row."id", transaction_row."amount_usd",
      transaction_row."balance_after_usd", transaction_row."billing_account_id"
    HAVING COALESCE(SUM(allocation."amount_usd"), 0) <> -transaction_row."amount_usd"
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = 'BALANCE_GRANT'
      ), 0) <> LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = CASE
          WHEN transaction_row."billing_account_id" = source_account_id
            THEN 'NEGATIVE_BALANCE' ELSE 'ENTERPRISE_CREDIT' END
      ), 0) <> -transaction_row."amount_usd" - LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
  ) invalid_consume;
  IF invalid_consume_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb consume allocation coverage invalid run=% count=%',
      target_run_id, invalid_consume_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_cross_account_settlement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE EXISTS (
      SELECT 1
      FROM "balance_grants" grant_row
      WHERE grant_row."id" = settlement."balance_grant_id"
        AND grant_row."billing_account_id" IN (source_account_id, target_account_id)
        AND settlement."billing_account_id" IS DISTINCT FROM grant_row."billing_account_id"
    )
    OR EXISTS (
      SELECT 1
      FROM "balance_consumption_allocations" allocation
      WHERE allocation."id" = settlement."allocation_id"
        AND allocation."billing_account_id" IN (source_account_id, target_account_id)
        AND settlement."billing_account_id" IS DISTINCT FROM allocation."billing_account_id"
    )
    OR EXISTS (
      SELECT 1
      FROM "balance_transactions" repayment
      WHERE repayment."id" = settlement."repayment_transaction_id"
        AND repayment."billing_account_id" IN (source_account_id, target_account_id)
        AND settlement."billing_account_id" IS DISTINCT FROM repayment."billing_account_id"
    );
  IF invalid_cross_account_settlement_count <> 0 THEN
    RAISE EXCEPTION
      'enterprise absorb cross-account settlement invalid run=% count=%',
      target_run_id, invalid_cross_account_settlement_count
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_settlement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."billing_account_id" IN (source_account_id, target_account_id);
  IF invalid_settlement_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb pair V1 does not support direct settlement run=% count=%',
      target_run_id, invalid_settlement_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_grant_conservation_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" IN (source_account_id, target_account_id)
    AND (
      grant_row."paid_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_paid_amount_usd"
        + COALESCE((SELECT SUM(allocation."recognized_revenue_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND allocation."source" = 'BALANCE_GRANT'), 0)
        + COALESCE((SELECT SUM(settlement."paid_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
            settlement."balance_grant_id",
            "balance_legacy_settlement_effective_grant_id"(settlement."id")
          ) = grant_row."id"
            AND settlement."billing_account_id" = grant_row."billing_account_id"
            AND settlement."trigger" = 'FUNDING'
            AND settlement."repair_run_id" IS NULL), 0)
      )
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_bonus_amount_usd"
        + COALESCE((SELECT SUM(allocation."bonus_consumed_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND allocation."source" = 'BALANCE_GRANT'), 0)
        + COALESCE((SELECT SUM(settlement."bonus_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
            settlement."balance_grant_id",
            "balance_legacy_settlement_effective_grant_id"(settlement."id")
          ) = grant_row."id"
            AND settlement."billing_account_id" = grant_row."billing_account_id"
            AND settlement."trigger" = 'FUNDING'
            AND settlement."repair_run_id" IS NULL), 0)
      )
    );
  IF invalid_grant_conservation_count <> 0 THEN
    RAISE EXCEPTION 'enterprise absorb grant conservation invalid run=% count=%',
      target_run_id, invalid_grant_conservation_count USING ERRCODE = '23514';
  END IF;

  source_wallet := source_account.wallet_balance;
  target_wallet := target_account.wallet_balance;
  source_path := "assert_balance_transaction_unique_wallet_path"(
    source_account_id, source_wallet
  );
  target_path := "assert_balance_transaction_unique_wallet_path"(
    target_account_id, target_wallet
  );
  PERFORM "assert_balance_allocation_sequence_order"(source_account_id, source_path);
  PERFORM "assert_balance_allocation_sequence_order"(target_account_id, target_path);

  SELECT COALESCE(SUM(grant_row."remaining_amount_usd") FILTER (
      WHERE NOT grant_row."is_expired"
        AND grant_row."valid_from" <= financial_now
        AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > financial_now)
    ), 0)
    INTO active_source_grants
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = source_account_id;
  SELECT COALESCE(SUM(grant_row."remaining_amount_usd") FILTER (
      WHERE NOT grant_row."is_expired"
        AND grant_row."valid_from" <= financial_now
        AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > financial_now)
    ), 0)
    INTO active_target_grants
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id;
  SELECT COALESCE(SUM(allocation."amount_usd" - allocation."settled_usd"), 0)
    INTO source_open_debt
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = source_account_id
    AND allocation."source" = 'NEGATIVE_BALANCE';
  SELECT COALESCE(SUM(allocation."amount_usd" - allocation."settled_usd"), 0)
    INTO target_open_debt
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = target_account_id
    AND allocation."source" = 'ENTERPRISE_CREDIT';
  IF source_wallet IS DISTINCT FROM active_source_grants - source_open_debt
    OR target_wallet IS DISTINCT FROM active_target_grants - target_open_debt
  THEN
    RAISE EXCEPTION 'enterprise absorb wallet/grant/debt mismatch run=% source=%/%-% target=%/%-%',
      target_run_id, source_wallet, active_source_grants, source_open_debt,
      target_wallet, active_target_grants, target_open_debt USING ERRCODE = '23514';
  END IF;

  SELECT transaction_row."id", transaction_row."balance_after_usd"
    INTO source_tail_id, source_tail_balance
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = source_account_id
  ORDER BY transaction_row."ledger_sequence" DESC LIMIT 1;
  SELECT transaction_row."id", transaction_row."balance_after_usd"
    INTO target_tail_id, target_tail_balance
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id
  ORDER BY transaction_row."ledger_sequence" DESC LIMIT 1;
  IF source_tail_balance IS DISTINCT FROM source_wallet
    OR target_tail_balance IS DISTINCT FROM target_wallet
  THEN
    RAISE EXCEPTION 'enterprise absorb transaction tail mismatch run=%', target_run_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO source_transaction_repairs
  FROM "balance_ledger_transaction_repairs"
  WHERE "run_id" = target_run_id AND "billing_account_id" = source_account_id;
  SELECT COUNT(*) INTO target_transaction_repairs
  FROM "balance_ledger_transaction_repairs"
  WHERE "run_id" = target_run_id AND "billing_account_id" = target_account_id;
  SELECT COUNT(*) INTO source_allocation_repairs
  FROM "balance_ledger_allocation_repairs"
  WHERE "run_id" = target_run_id AND "billing_account_id" = source_account_id;
  SELECT COUNT(*) INTO target_allocation_repairs
  FROM "balance_ledger_allocation_repairs"
  WHERE "run_id" = target_run_id AND "billing_account_id" = target_account_id;

  IF pair_is_terminal THEN
    WITH mutations AS (
      SELECT source_account_id AS billing_account_id,
        source_repair."id" AS repair_account_id, value AS mutation
      FROM jsonb_array_elements(COALESCE(
        source_repair."after_snapshot"->'grantMutations', '[]'::JSONB
      )) value
      UNION ALL
      SELECT target_account_id, target_repair."id", value
      FROM jsonb_array_elements(COALESCE(
        target_repair."after_snapshot"->'grantMutations', '[]'::JSONB
      )) value
    ), duplicate_mutations AS (
      SELECT billing_account_id, mutation->>'grantId' AS grant_id
      FROM mutations
      GROUP BY billing_account_id, mutation->>'grantId'
      HAVING COUNT(*) <> 1
    )
    SELECT
      (SELECT COUNT(*)
       FROM "balance_ledger_grant_component_repairs" component_repair
       LEFT JOIN mutations mutation
         ON mutation.billing_account_id = component_repair."billing_account_id"
         AND mutation.repair_account_id = component_repair."repair_account_id"
         AND mutation.mutation->>'grantId' = component_repair."grant_id"
       WHERE component_repair."run_id" = target_run_id
         AND (
           mutation.mutation IS NULL
           OR (mutation.mutation->>'expectedRemainingAmountUsd')::NUMERIC
             IS DISTINCT FROM
               (component_repair."before_snapshot"->>'remaining_amount_usd')::NUMERIC
           OR mutation.mutation->'expectedRemainingPaidAmountUsd' <> 'null'::JSONB
           OR mutation.mutation->'expectedRemainingBonusAmountUsd' <> 'null'::JSONB
           OR (mutation.mutation->>'remainingAmountUsd')::NUMERIC
             IS DISTINCT FROM
               (component_repair."after_snapshot"->>'remaining_amount_usd')::NUMERIC
           OR (mutation.mutation->>'remainingPaidAmountUsd')::NUMERIC
             IS DISTINCT FROM
               (component_repair."after_snapshot"->>'remaining_paid_amount_usd')::NUMERIC
           OR (mutation.mutation->>'remainingBonusAmountUsd')::NUMERIC
             IS DISTINCT FROM
               (component_repair."after_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC
         ))
      + (SELECT COUNT(*)
         FROM mutations mutation
         LEFT JOIN "balance_ledger_grant_component_repairs" component_repair
           ON component_repair."run_id" = target_run_id
           AND component_repair."billing_account_id" = mutation.billing_account_id
           AND component_repair."repair_account_id" = mutation.repair_account_id
           AND component_repair."grant_id" = mutation.mutation->>'grantId'
         WHERE component_repair."id" IS NULL)
      + (SELECT COUNT(*) FROM duplicate_mutations)
      INTO invalid_grant_component_repair_count;
    IF invalid_grant_component_repair_count <> 0 THEN
      RAISE EXCEPTION 'enterprise absorb terminal grant mutation proof mismatch run=% count=%',
        target_run_id, invalid_grant_component_repair_count USING ERRCODE = '23514';
    END IF;
  END IF;

  IF pair_is_terminal AND (
    source_account."balance_grant_ledger_through_transaction_id"
      IS DISTINCT FROM source_tail_id
    OR target_account."balance_grant_ledger_through_transaction_id"
      IS DISTINCT FROM target_tail_id
    OR source_repair."after_snapshot"->>'transactionTailId' IS DISTINCT FROM source_tail_id
    OR target_repair."after_snapshot"->>'transactionTailId' IS DISTINCT FROM target_tail_id
    OR (source_repair."after_snapshot"->>'walletBalanceUsd')::NUMERIC
      IS DISTINCT FROM source_wallet
    OR (target_repair."after_snapshot"->>'walletBalanceUsd')::NUMERIC
      IS DISTINCT FROM target_wallet
    OR (source_repair."after_snapshot"->>'transactionRepairCount')::BIGINT
      IS DISTINCT FROM source_transaction_repairs
    OR (target_repair."after_snapshot"->>'transactionRepairCount')::BIGINT
      IS DISTINCT FROM target_transaction_repairs
    OR (source_repair."after_snapshot"->>'grantComponentRepairCount')::BIGINT
      IS DISTINCT FROM source_grant_component_repairs
    OR (target_repair."after_snapshot"->>'grantComponentRepairCount')::BIGINT
      IS DISTINCT FROM target_grant_component_repairs
    OR (source_repair."after_snapshot"->>'allocationRepairCount')::BIGINT
      IS DISTINCT FROM source_allocation_repairs
    OR (target_repair."after_snapshot"->>'allocationRepairCount')::BIGINT
      IS DISTINCT FROM target_allocation_repairs
  ) THEN
    RAISE EXCEPTION 'enterprise absorb terminal repair snapshot mismatch run=%', target_run_id
      USING ERRCODE = '23514';
  END IF;
EXCEPTION
  WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'enterprise absorb pair proof contains invalid typed evidence run=%', target_run_id
      USING ERRCODE = '23514';
END
$$;

-- The separately gated expiry-v2 rollout rejects cross-account grant
-- allocations at the row boundary.  Authorize only an UPDATE whose exact
-- OLD/NEW row images were registered by the active pair run and whose OLD
-- image is present in the immutable source-allocation transfer proof.
CREATE OR REPLACE FUNCTION
  "balance_enterprise_absorb_active_allocation_update_is_valid"(
    target_before_snapshot JSONB,
    target_after_snapshot JSONB
  )
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM "balance_ledger_allocation_repairs" allocation_repair
    JOIN "balance_ledger_repair_accounts" source_repair
      ON source_repair."id" = allocation_repair."repair_account_id"
    JOIN "balance_ledger_account_transfer_repairs" transfer_proof
      ON transfer_proof."run_id" = allocation_repair."run_id"
      AND transfer_proof."source_repair_account_id" = source_repair."id"
      AND transfer_proof."source_billing_account_id"
        = allocation_repair."billing_account_id"
    JOIN "balance_ledger_repair_accounts" target_repair
      ON target_repair."id" = transfer_proof."target_repair_account_id"
    JOIN "balance_ledger_repair_runs" repair_run
      ON repair_run."id" = transfer_proof."run_id"
    JOIN "balance_ledger_account_transfer_grants" grant_proof
      ON grant_proof."transfer_repair_id" = transfer_proof."id"
      AND grant_proof."grant_id" = target_before_snapshot->>'balance_grant_id'
    CROSS JOIN LATERAL jsonb_array_elements(
      grant_proof."source_allocations_snapshot"
    ) source_snapshot
    WHERE target_before_snapshot IS NOT NULL
      AND target_after_snapshot IS NOT NULL
      AND transfer_proof."run_id" = NULLIF(
        btrim(current_setting('billing.balance_ledger_repair_run_id', TRUE)),
        ''
      )
      AND repair_run."status" = 'RUNNING'
      AND source_repair."status" = 'RUNNING'
      AND target_repair."status" = 'RUNNING'
      AND source_repair."run_id" = transfer_proof."run_id"
      AND target_repair."run_id" = transfer_proof."run_id"
      AND source_repair."billing_account_id"
        = transfer_proof."source_billing_account_id"
      AND target_repair."billing_account_id"
        = transfer_proof."target_billing_account_id"
      AND transfer_proof."source_billing_account_id"
        <> transfer_proof."target_billing_account_id"
      AND allocation_repair."allocation_id" = target_before_snapshot->>'id'
      AND allocation_repair."billing_account_id"
        = target_before_snapshot->>'billing_account_id'
      AND allocation_repair."operation_key" =
        'repair:allocation:' || transfer_proof."run_id" || ':'
          || allocation_repair."allocation_id"
      AND allocation_repair."before_snapshot" = target_before_snapshot
      AND allocation_repair."after_snapshot" = target_after_snapshot
      AND target_after_snapshot->>'id' = target_before_snapshot->>'id'
      AND target_after_snapshot->>'billing_account_id'
        = target_before_snapshot->>'billing_account_id'
      AND target_after_snapshot->>'balance_grant_id'
        = target_before_snapshot->>'balance_grant_id'
      AND source_snapshot = target_before_snapshot
  ), FALSE)
$$;

-- Give both installation orders one exact pair-aware deferred dispatch
-- contract: a GUC can identify a candidate run, but only the database
-- transfer proof and the full pair assertion can authorize it.
CREATE OR REPLACE FUNCTION "balance_enterprise_absorb_active_pair_is_valid"(
  target_account_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  pair_count BIGINT;
  source_account_id TEXT;
  target_pair_account_id TEXT;
BEGIN
  IF target_account_id IS NULL THEN
    RETURN FALSE;
  END IF;
  active_run_id := NULLIF(
    btrim(current_setting('billing.balance_ledger_repair_run_id', TRUE)),
    ''
  );
  IF active_run_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT
    COUNT(*),
    MIN(transfer_proof."source_billing_account_id"),
    MIN(transfer_proof."target_billing_account_id")
    INTO pair_count, source_account_id, target_pair_account_id
  FROM "balance_ledger_account_transfer_repairs" transfer_proof
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = transfer_proof."run_id"
  WHERE transfer_proof."run_id" = active_run_id
    AND repair_run."status" = 'RUNNING'
    AND transfer_proof."source_billing_account_id"
      <> transfer_proof."target_billing_account_id"
    AND target_account_id IN (
      transfer_proof."source_billing_account_id",
      transfer_proof."target_billing_account_id"
    );

  IF pair_count = 0 THEN
    RETURN FALSE;
  END IF;
  IF pair_count <> 1 THEN
    RAISE EXCEPTION
      'enterprise absorb active run has ambiguous account pair run=% account=% count=%',
      active_run_id,
      target_account_id,
      pair_count
      USING ERRCODE = '23514';
  END IF;

  PERFORM "assert_balance_enterprise_absorb_pair_repair"(
    active_run_id,
    source_account_id,
    target_pair_account_id
  );
  RETURN TRUE;
END
$$;

-- Deterministic row-boundary upgrade for environments that installed the
-- expiry-v2 allocation identity guard before this pair contract.
DO $expiry_guard_upgrade$
BEGIN
  IF to_regprocedure(
      'public.guard_balance_consumption_allocation_identity()'
    ) IS NOT NULL
  THEN
    EXECUTE $guard_definition$
CREATE OR REPLACE FUNCTION "guard_balance_consumption_allocation_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_type TEXT;
  target_account_status TEXT;
  transaction_account_id TEXT;
  transaction_user_id TEXT;
  transaction_tenant_id TEXT;
  transaction_product_id TEXT;
  transaction_token_usage_id TEXT;
  transaction_type TEXT;
  grant_account_id TEXT;
BEGIN
  IF NEW."billing_account_id" IS NULL THEN
    RAISE EXCEPTION
      'balance allocation requires billing account allocation=%',
      NEW."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT account."type", account."balance_grant_ledger_status"
    INTO target_account_type, target_account_status
  FROM "billing_accounts" account
  WHERE account."id" = NEW."billing_account_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'balance allocation references missing account allocation=% account=%',
      NEW."id",
      NEW."billing_account_id"
      USING ERRCODE = '23514';
  END IF;

  SELECT
    transaction_row."billing_account_id",
    transaction_row."user_id",
    transaction_row."tenant_id",
    transaction_row."product_id",
    transaction_row."token_usage_id",
    transaction_row."type"::TEXT
    INTO
      transaction_account_id,
      transaction_user_id,
      transaction_tenant_id,
      transaction_product_id,
      transaction_token_usage_id,
      transaction_type
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."id" = NEW."balance_transaction_id";
  IF NOT FOUND
    OR transaction_type NOT IN ('CONSUME', 'REFUND')
    OR transaction_account_id IS DISTINCT FROM NEW."billing_account_id"
    OR transaction_user_id IS DISTINCT FROM NEW."user_id"
    OR transaction_tenant_id IS DISTINCT FROM NEW."tenant_id"
    OR transaction_product_id IS DISTINCT FROM NEW."product_id"
    OR transaction_token_usage_id IS DISTINCT FROM NEW."token_usage_id"
  THEN
    RAISE EXCEPTION
      'balance allocation subject does not match transaction allocation=% transaction=% account=%',
      NEW."id",
      NEW."balance_transaction_id",
      NEW."billing_account_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."source" = 'BALANCE_GRANT' THEN
    IF transaction_type IS DISTINCT FROM 'CONSUME'
      OR NEW."balance_grant_id" IS NULL
    THEN
      RAISE EXCEPTION
        'balance grant allocation requires grant allocation=%',
        NEW."id"
        USING ERRCODE = '23514';
    END IF;
    SELECT grant_row."billing_account_id"
      INTO grant_account_id
    FROM "balance_grants" grant_row
    WHERE grant_row."id" = NEW."balance_grant_id";
    IF NOT FOUND
      OR (
        grant_account_id IS DISTINCT FROM NEW."billing_account_id"
        AND (
          TG_OP <> 'UPDATE'
          OR NOT "balance_enterprise_absorb_active_allocation_update_is_valid"(
            to_jsonb(OLD),
            to_jsonb(NEW)
          )
        )
      )
    THEN
      RAISE EXCEPTION
        'balance allocation grant account mismatch allocation=% grant=% account=%',
        NEW."id",
        NEW."balance_grant_id",
        NEW."billing_account_id"
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."source" = 'UNRECONCILED_GRANT' THEN
    IF transaction_type IS DISTINCT FROM 'CONSUME'
      OR target_account_status IS DISTINCT FROM 'LEGACY_DIRTY'
    THEN
      RAISE EXCEPTION
        'unreconciled grant allocation is dirty-consume only allocation=% account=% status=%',
        NEW."id",
        NEW."billing_account_id",
        target_account_status
        USING ERRCODE = '23514';
    END IF;
    IF NEW."balance_grant_id" IS NOT NULL THEN
      SELECT grant_row."billing_account_id"
        INTO grant_account_id
      FROM "balance_grants" grant_row
      WHERE grant_row."id" = NEW."balance_grant_id";
      IF NOT FOUND
        OR grant_account_id IS DISTINCT FROM NEW."billing_account_id"
      THEN
        RAISE EXCEPTION
          'unreconciled allocation grant account mismatch allocation=% grant=% account=%',
          NEW."id",
          NEW."balance_grant_id",
          NEW."billing_account_id"
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW."source" = 'NEGATIVE_BALANCE' THEN
    IF target_account_type IS DISTINCT FROM 'personal'
      OR NEW."balance_grant_id" IS NOT NULL
    THEN
      RAISE EXCEPTION
        'negative balance allocation identity invalid allocation=% account=% type=%',
        NEW."id",
        NEW."billing_account_id",
        target_account_type
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."source" = 'ENTERPRISE_CREDIT' THEN
    IF target_account_type IS DISTINCT FROM 'enterprise'
      OR NEW."balance_grant_id" IS NOT NULL
    THEN
      RAISE EXCEPTION
        'enterprise credit allocation identity invalid allocation=% account=% type=%',
        NEW."id",
        NEW."billing_account_id",
        target_account_type
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION
      'balance allocation source invalid allocation=% source=%',
      NEW."id",
      NEW."source"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;
    $guard_definition$;
  END IF;
END
$expiry_guard_upgrade$;

-- Deterministic final expiry-v2 canonical definition for environments that
-- installed any older rollout revision before this migration.  The gated
-- rollout carries the same body for fresh installs in the opposite order.
DO $expiry_canonical_upgrade$
BEGIN
  IF to_regprocedure(
      'public.assert_clean_account_wallet_canonical_deferred()'
    ) IS NOT NULL
  THEN
    EXECUTE $canonical_definition$
CREATE OR REPLACE FUNCTION "assert_clean_account_wallet_canonical_deferred"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id TEXT;
  account_type TEXT;
  account_status TEXT;
  account_reconciled_at TIMESTAMP(3);
  wallet_balance NUMERIC;
  active_grant_amount NUMERIC;
  open_debt_amount NUMERIC;
  invalid_grant_count BIGINT;
  invalid_grant_conservation_count BIGINT;
  invalid_debt_count BIGINT;
  invalid_sequence_count BIGINT;
  unexpected_debt_count BIGINT;
  expected_debt_source TEXT;
  transaction_total NUMERIC;
  invalid_transaction_count BIGINT;
  invalid_allocation_count BIGINT;
  invalid_consume_count BIGINT;
  invalid_refund_transaction_count BIGINT;
  financial_now_text TEXT;
  parsed_financial_now TIMESTAMP(3);
  revision_state JSONB;
  validated_state JSONB;
  current_revision BIGINT;
  validated_revision BIGINT;
BEGIN
  target_account_id := NEW."billing_account_id";
  SELECT
    account."type",
    account."balance_grant_ledger_status",
    account."balance_grant_ledger_reconciled_at",
    wallet."balance_usd"
    INTO account_type, account_status, account_reconciled_at, wallet_balance
  FROM "billing_accounts" account
  JOIN "account_wallets" wallet
    ON wallet."billing_account_id" = account."id"
  WHERE account."id" = target_account_id;

  IF NOT FOUND OR account_status <> 'RECONCILED_V2' THEN
    RETURN NULL;
  END IF;

  -- A legacy personal->enterprise absorb pair is repaired atomically across
  -- two accounts.  During that one repair transaction, validate the exact
  -- database-backed pair proof instead of evaluating either side in
  -- isolation.  The helper returns FALSE for every non-pair writer, so the
  -- canonical validator below remains the default path.
  IF "balance_enterprise_absorb_active_pair_is_valid"(target_account_id) THEN
    RETURN NULL;
  END IF;

  BEGIN
    revision_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_revisions', TRUE), ''),
      '{}'
    )::JSONB;
    validated_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_validated', TRUE), ''),
      '{}'
    )::JSONB;
    current_revision := COALESCE(
      (revision_state ->> target_account_id)::BIGINT,
      0
    );
    validated_revision := COALESCE(
      (validated_state ->> target_account_id)::BIGINT,
      0
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'clean account canonical validation state invalid account=%',
      target_account_id
      USING ERRCODE = '23514';
  END;
  IF current_revision <= 0 THEN
    RAISE EXCEPTION
      'clean account canonical mutation lacks revision marker account=%',
      target_account_id
      USING ERRCODE = '23514';
  END IF;
  IF validated_revision = current_revision THEN
    RETURN NULL;
  END IF;

  -- Use one immutable writer clock for every table participating in the
  -- canonical aggregate. No live wall clock is sampled by deferred triggers.
  financial_now_text := current_setting('billing.balance_financial_now', TRUE);
  IF financial_now_text IS NOT NULL AND btrim(financial_now_text) <> '' THEN
    BEGIN
      parsed_financial_now := financial_now_text::TIMESTAMP(3);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'clean account mutation has invalid locked financial now: %',
        target_account_id
        USING ERRCODE = '23514';
    END;
  END IF;
  -- EMPTY_V2 wallet creation at zero is non-financial. Every non-zero INSERT
  -- or actual wallet balance change must come from a post-lock V2 writer.
  IF TG_TABLE_NAME = 'account_wallets' THEN
    IF (
      (TG_OP = 'INSERT' AND NEW."balance_usd" <> 0)
      OR (TG_OP = 'UPDATE' AND NEW."balance_usd" IS DISTINCT FROM OLD."balance_usd")
    )
      AND parsed_financial_now IS NULL
    THEN
      RAISE EXCEPTION
        'clean account wallet mutation lacks locked financial now: %',
        target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT
    COALESCE(SUM(grant_row."remaining_amount_usd") FILTER (
      WHERE NOT grant_row."is_expired"
        AND grant_row."valid_from" <= COALESCE(
          parsed_financial_now,
          account_reconciled_at
        )
        AND (
          grant_row."expires_at" IS NULL
          OR grant_row."expires_at" > COALESCE(
            parsed_financial_now,
            account_reconciled_at
          )
        )
    ), 0),
    COUNT(*) FILTER (
      WHERE grant_row."remaining_amount_usd" < 0
        OR grant_row."remaining_paid_amount_usd" IS NULL
        OR grant_row."remaining_bonus_amount_usd" IS NULL
        OR grant_row."remaining_paid_amount_usd" < 0
        OR grant_row."remaining_bonus_amount_usd" < 0
        OR grant_row."remaining_paid_amount_usd"
          + grant_row."remaining_bonus_amount_usd"
          <> grant_row."remaining_amount_usd"
        OR grant_row."paid_amount_usd" < 0
        OR grant_row."bonus_amount_usd" < 0
        OR grant_row."granted_amount_usd" <= 0
        OR grant_row."paid_amount_usd" + grant_row."bonus_amount_usd"
          <> grant_row."granted_amount_usd"
        OR grant_row."discount_rate" IS DISTINCT FROM CASE
          WHEN grant_row."granted_amount_usd" > 0 THEN ROUND(
            grant_row."paid_amount_usd" / grant_row."granted_amount_usd",
            12
          )
          ELSE 0
        END
        OR grant_row."remaining_paid_amount_usd" > grant_row."paid_amount_usd"
        OR grant_row."remaining_bonus_amount_usd" > grant_row."bonus_amount_usd"
        OR (
          grant_row."valid_from" > grant_row."created_at"
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_funding_candidates"(
              target_account_id,
              account_type
            ) proven_funding
            WHERE proven_funding.grant_id = grant_row."id"
          )
        )
        OR (
          grant_row."expires_at" IS NOT NULL
          AND grant_row."expires_at" <= grant_row."valid_from"
        )
        OR (
          grant_row."is_expired"
          AND (
            grant_row."remaining_amount_usd" <> 0
            OR grant_row."remaining_paid_amount_usd" <> 0
            OR grant_row."remaining_bonus_amount_usd" <> 0
          )
        )
    )
    INTO active_grant_amount, invalid_grant_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id;

  -- Aggregate equality is insufficient: moving the same amount between two
  -- grants leaves the wallet unchanged while corrupting the recharge-detail
  -- rows. Prove each paid/bonus component independently from immutable facts.
  -- REFUND_NETTING settlements and refund allocations describe the same grant
  -- reduction, so only the latter participates in this equation.
  SELECT COUNT(*) INTO invalid_grant_conservation_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id
    AND (
      grant_row."paid_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_paid_amount_usd"
        + COALESCE((
          SELECT SUM(allocation."recognized_revenue_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND (
              allocation."billing_account_id" = target_account_id
              OR "balance_allocation_has_enterprise_absorb_proof"(
                allocation."id",
                grant_row."id",
                allocation."billing_account_id"
              )
            )
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
        + COALESCE((
          SELECT SUM(settlement."paid_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = grant_row."id"
            AND settlement."billing_account_id" = target_account_id
            AND settlement."trigger" <> 'REFUND_NETTING'
        ), 0)
        + COALESCE((
          SELECT SUM(refund_allocation."paid_reduction_usd")
          FROM "balance_grant_refund_allocations" refund_allocation
          JOIN "balance_grant_refunds" refund
            ON refund."id" = refund_allocation."refund_id"
          WHERE refund_allocation."balance_grant_id" = grant_row."id"
            AND refund."billing_account_id" = target_account_id
        ), 0)
        + COALESCE((
          SELECT expiry."nominal_paid_usd"
          FROM "balance_grant_expiries" expiry
          WHERE expiry."balance_grant_id" = grant_row."id"
            AND expiry."billing_account_id" = target_account_id
        ), 0)
      )
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_bonus_amount_usd"
        + COALESCE((
          SELECT SUM(allocation."bonus_consumed_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND (
              allocation."billing_account_id" = target_account_id
              OR "balance_allocation_has_enterprise_absorb_proof"(
                allocation."id",
                grant_row."id",
                allocation."billing_account_id"
              )
            )
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
        + COALESCE((
          SELECT SUM(settlement."bonus_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = grant_row."id"
            AND settlement."billing_account_id" = target_account_id
            AND settlement."trigger" <> 'REFUND_NETTING'
        ), 0)
        + COALESCE((
          SELECT SUM(refund_allocation."bonus_reduction_usd")
          FROM "balance_grant_refund_allocations" refund_allocation
          JOIN "balance_grant_refunds" refund
            ON refund."id" = refund_allocation."refund_id"
          WHERE refund_allocation."balance_grant_id" = grant_row."id"
            AND refund."billing_account_id" = target_account_id
        ), 0)
        + COALESCE((
          SELECT expiry."nominal_bonus_usd"
          FROM "balance_grant_expiries" expiry
          WHERE expiry."balance_grant_id" = grant_row."id"
            AND expiry."billing_account_id" = target_account_id
        ), 0)
      )
    );

  expected_debt_source := CASE
    WHEN account_type = 'enterprise' THEN 'ENTERPRISE_CREDIT'
    ELSE 'NEGATIVE_BALANCE'
  END;

  SELECT
    COALESCE(SUM(allocation."amount_usd" - allocation."settled_usd") FILTER (
      WHERE allocation."source" = expected_debt_source
    ), 0),
    COUNT(*) FILTER (
      WHERE allocation."amount_usd" <= 0
        OR allocation."settled_usd" < 0
        OR allocation."settled_usd" > allocation."amount_usd"
        OR allocation."recognized_revenue_usd" < 0
        OR allocation."bonus_consumed_usd" < 0
        OR allocation."recognized_revenue_usd"
          + allocation."bonus_consumed_usd" <> allocation."settled_usd"
        OR allocation."balance_grant_id" IS NOT NULL
        OR allocation."discount_rate" <> 0
        OR (allocation."settled_usd" = allocation."amount_usd")
          IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
    ),
    COUNT(*) FILTER (
      WHERE allocation."ledger_sequence" IS NULL
        OR allocation."ledger_sequence" = 0
    ),
    COUNT(*) FILTER (
      WHERE allocation."source" <> expected_debt_source
    )
    INTO
      open_debt_amount,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = target_account_id
    AND allocation."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT');

  SELECT
    COALESCE(SUM(transaction_row."amount_usd"), 0),
    COUNT(*) FILTER (
      WHERE transaction_row."ledger_sequence" IS NULL
        OR transaction_row."ledger_sequence" = 0
        OR (transaction_row."type"::TEXT = 'CONSUME' AND transaction_row."amount_usd" >= 0)
        OR (transaction_row."type"::TEXT = 'RECHARGE' AND transaction_row."amount_usd" <= 0)
        OR (transaction_row."type"::TEXT = 'REFUND' AND transaction_row."amount_usd" >= 0)
        OR (transaction_row."type"::TEXT = 'ADJUST' AND transaction_row."amount_usd" = 0)
        OR transaction_row."type"::TEXT NOT IN ('CONSUME', 'RECHARGE', 'REFUND', 'ADJUST')
    )
    INTO transaction_total, invalid_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id;

  SELECT COUNT(*) FILTER (
    WHERE allocation."ledger_sequence" IS NULL
      OR allocation."ledger_sequence" = 0
      OR allocation."amount_usd" <= 0
      OR transaction_row."id" IS NULL
      OR transaction_row."billing_account_id" IS DISTINCT FROM target_account_id
      OR transaction_row."type"::TEXT NOT IN ('CONSUME', 'REFUND')
      OR allocation."user_id" IS DISTINCT FROM transaction_row."user_id"
      OR allocation."tenant_id" IS DISTINCT FROM transaction_row."tenant_id"
      OR allocation."product_id" IS DISTINCT FROM transaction_row."product_id"
      OR allocation."token_usage_id" IS DISTINCT FROM transaction_row."token_usage_id"
      OR (
        allocation."source" = 'BALANCE_GRANT'
        AND (
          transaction_row."type"::TEXT <> 'CONSUME'
          OR
          grant_row."id" IS NULL
          OR (
            grant_row."billing_account_id" IS DISTINCT FROM target_account_id
            AND NOT "balance_allocation_has_enterprise_absorb_proof"(
              allocation."id",
              grant_row."id",
              target_account_id
            )
          )
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."amount_usd"
          OR allocation."discount_rate" IS DISTINCT FROM CASE
            WHEN allocation."amount_usd" > 0 THEN ROUND(
              allocation."recognized_revenue_usd" / allocation."amount_usd",
              12
            )
            ELSE 0
          END
          OR allocation."settled_usd" <> 0
          OR allocation."settled_at" IS NOT NULL
        )
      )
      OR (
        allocation."source" = expected_debt_source
        AND (
          allocation."balance_grant_id" IS NOT NULL
          OR allocation."discount_rate" <> 0
          OR allocation."settled_usd" < 0
          OR allocation."settled_usd" > allocation."amount_usd"
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."settled_usd"
          OR (allocation."settled_usd" = allocation."amount_usd")
            IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
          OR (
            transaction_row."type"::TEXT = 'REFUND'
            AND NOT EXISTS (
              SELECT 1
              FROM "balance_grant_refunds" refund
              WHERE refund."debt_allocation_id" = allocation."id"
                AND refund."refund_transaction_id" = transaction_row."id"
                AND refund."billing_account_id" = target_account_id
                AND refund."operation_key" IS NOT DISTINCT FROM
                  transaction_row."operation_key"
                AND refund."requested_amount_usd" = -transaction_row."amount_usd"
                AND refund."debt_opened_usd" = allocation."amount_usd"
                AND refund."debt_netted_usd" <= allocation."settled_usd"
                AND refund."open_debt_usd"
                  = refund."debt_opened_usd" - refund."debt_netted_usd"
                AND refund."occurred_at" = transaction_row."created_at"
                AND refund."debt_netted_usd" = COALESCE((
                  SELECT SUM(settlement."amount_usd")
                  FROM "enterprise_credit_settlements" settlement
                  WHERE settlement."allocation_id" = allocation."id"
                    AND settlement."repayment_transaction_id" = transaction_row."id"
                    AND settlement."trigger" = 'REFUND_NETTING'
                ), 0)
            )
          )
          OR (
            transaction_row."type"::TEXT = 'CONSUME'
            AND EXISTS (
              SELECT 1
              FROM "balance_grant_refunds" refund
              WHERE refund."debt_allocation_id" = allocation."id"
            )
          )
        )
      )
      OR allocation."source" NOT IN ('BALANCE_GRANT', expected_debt_source)
  )
    INTO invalid_allocation_count
  FROM "balance_consumption_allocations" allocation
  LEFT JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = allocation."balance_transaction_id"
  LEFT JOIN "balance_grants" grant_row
    ON grant_row."id" = allocation."balance_grant_id"
  WHERE allocation."billing_account_id" = target_account_id;

  invalid_allocation_count := invalid_allocation_count + (
    SELECT COUNT(*)
    FROM "balance_consumption_allocations" foreign_allocation
    JOIN "balance_transactions" target_transaction
      ON target_transaction."id" = foreign_allocation."balance_transaction_id"
    WHERE target_transaction."billing_account_id" = target_account_id
      AND foreign_allocation."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "balance_consumption_allocations" foreign_allocation
    JOIN "balance_grants" target_grant
      ON target_grant."id" = foreign_allocation."balance_grant_id"
    WHERE target_grant."billing_account_id" = target_account_id
      AND foreign_allocation."billing_account_id" IS DISTINCT FROM target_account_id
      AND NOT "balance_allocation_has_enterprise_absorb_proof"(
        foreign_allocation."id",
        target_grant."id",
        foreign_allocation."billing_account_id"
      )
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_grants" target_grant
      ON target_grant."id" = foreign_settlement."balance_grant_id"
    WHERE target_grant."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_consumption_allocations" target_allocation
      ON target_allocation."id" = foreign_settlement."allocation_id"
    WHERE target_allocation."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_transactions" target_repayment
      ON target_repayment."id" = foreign_settlement."repayment_transaction_id"
    WHERE target_repayment."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  );

  SELECT COUNT(*) INTO invalid_consume_count
  FROM (
    SELECT transaction_row."id"
    FROM "balance_transactions" transaction_row
    LEFT JOIN "balance_consumption_allocations" allocation
      ON allocation."balance_transaction_id" = transaction_row."id"
      AND allocation."billing_account_id" = target_account_id
    WHERE transaction_row."billing_account_id" = target_account_id
      AND transaction_row."type"::TEXT = 'CONSUME'
    GROUP BY
      transaction_row."id",
      transaction_row."amount_usd",
      transaction_row."balance_after_usd"
    HAVING COALESCE(SUM(allocation."amount_usd"), 0) <> -transaction_row."amount_usd"
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = 'BALANCE_GRANT'
      ), 0) <> LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = expected_debt_source
      ), 0) <> -transaction_row."amount_usd" - LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
  ) invalid_consume;

  -- Negative ledger sequences are repair-proven legacy history. Every
  -- post-expand REFUND receives a positive database sequence and must have a
  -- terminal immutable refund audit before the transaction can commit.
  SELECT COUNT(*) INTO invalid_refund_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id
    AND transaction_row."type"::TEXT = 'REFUND'
    AND transaction_row."ledger_sequence" > 0
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_grant_refunds" refund
      WHERE refund."refund_transaction_id" = transaction_row."id"
        AND refund."billing_account_id" = target_account_id
        AND refund."operation_key" IS NOT DISTINCT FROM
          transaction_row."operation_key"
        AND refund."requested_amount_usd" = -transaction_row."amount_usd"
        AND refund."occurred_at" = transaction_row."created_at"
    );

  IF active_grant_amount IS DISTINCT FROM GREATEST(wallet_balance, 0)
    OR open_debt_amount IS DISTINCT FROM GREATEST(-wallet_balance, 0)
    OR wallet_balance IS DISTINCT FROM active_grant_amount - open_debt_amount
    OR transaction_total IS DISTINCT FROM wallet_balance
    OR invalid_transaction_count <> 0
    OR invalid_grant_count <> 0
    OR invalid_grant_conservation_count <> 0
    OR invalid_debt_count <> 0
    OR invalid_sequence_count <> 0
    OR unexpected_debt_count <> 0
    OR invalid_allocation_count <> 0
    OR invalid_consume_count <> 0
    OR invalid_refund_transaction_count <> 0
  THEN
    RAISE EXCEPTION
      'clean account canonical invariant invalid account=% wallet=% tx=% active=% debt=% invalid(tx/grant/grant_conservation/debt/sequence/unexpected/allocation/consume/refund)=%/%/%/%/%/%/%/%/%',
      target_account_id,
      wallet_balance,
      transaction_total,
      active_grant_amount,
      open_debt_amount,
      invalid_transaction_count,
      invalid_grant_count,
      invalid_grant_conservation_count,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count,
      invalid_allocation_count,
      invalid_consume_count,
      invalid_refund_transaction_count
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'billing.balance_canonical_validated',
    jsonb_set(
      validated_state,
      ARRAY[target_account_id],
      to_jsonb(current_revision),
      TRUE
    )::TEXT,
    TRUE
  );

  RETURN NULL;
END
$$;
    $canonical_definition$;
  END IF;
END
$expiry_canonical_upgrade$;

CREATE OR REPLACE FUNCTION "validate_balance_enterprise_absorb_pair_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "balance_ledger_repair_accounts" source_repair
    JOIN "balance_ledger_repair_accounts" target_repair
      ON target_repair."id" = NEW."target_repair_account_id"
    JOIN "billing_accounts" source_account
      ON source_account."id" = NEW."source_billing_account_id"
    JOIN "billing_accounts" target_account
      ON target_account."id" = NEW."target_billing_account_id"
    WHERE source_repair."id" = NEW."source_repair_account_id"
      AND source_repair."status" = 'APPLIED'
      AND target_repair."status" = 'APPLIED'
      AND source_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND target_account."balance_grant_ledger_status" = 'RECONCILED_V2'
      AND source_account."balance_grant_ledger_hash" = source_repair."replay_hash"
      AND target_account."balance_grant_ledger_hash" = target_repair."replay_hash"
  ) THEN
    RAISE EXCEPTION 'enterprise absorb proof cannot commit before both accounts are terminal: %',
      NEW."id" USING ERRCODE = '23514';
  END IF;
  PERFORM "assert_balance_enterprise_absorb_pair_repair"(
    NEW."run_id", NEW."source_billing_account_id", NEW."target_billing_account_id"
  );
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_transfer_repairs_terminal_deferred"
AFTER INSERT ON "balance_ledger_account_transfer_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_balance_enterprise_absorb_pair_terminal"();

-- Preserve the generic promotion validator for every normal account.  Only an
-- exact pair proof in the active repair run is routed to the pair assertion;
-- session GUCs alone never authorize an exception.
CREATE OR REPLACE FUNCTION "validate_balance_ledger_clean_promotion"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  pair_proof RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2' THEN
      PERFORM "assert_balance_ledger_canonical_promotion"(NEW."id", NULL, TRUE);
    END IF;
  ELSIF OLD."balance_grant_ledger_status" <> 'RECONCILED_V2'
    AND NEW."balance_grant_ledger_status" = 'RECONCILED_V2'
  THEN
    active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
    SELECT proof.* INTO pair_proof
    FROM "balance_ledger_account_transfer_repairs" proof
    WHERE proof."run_id" = active_run_id
      AND NEW."id" IN (
        proof."source_billing_account_id", proof."target_billing_account_id"
      );
    IF pair_proof."id" IS NOT NULL THEN
      PERFORM "assert_balance_enterprise_absorb_pair_repair"(
        pair_proof."run_id",
        pair_proof."source_billing_account_id",
        pair_proof."target_billing_account_id"
      );
    ELSE
      PERFORM "assert_balance_ledger_canonical_promotion"(
        NEW."id", active_run_id, FALSE
      );
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- The repaired admin grant is paid-only and exactly backed by its immutable
-- legacy ADJUST/idempotency proof.  All other grants continue through the
-- original canonical funding aggregate.
CREATE OR REPLACE FUNCTION "validate_balance_grant_funding_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW."paid_amount_usd" IS NOT DISTINCT FROM OLD."paid_amount_usd"
    AND NEW."bonus_amount_usd" IS NOT DISTINCT FROM OLD."bonus_amount_usd"
    AND NEW."granted_amount_usd" IS NOT DISTINCT FROM OLD."granted_amount_usd"
    AND NEW."discount_rate" IS NOT DISTINCT FROM OLD."discount_rate"
  THEN
    RETURN NEW;
  END IF;
  IF "balance_grant_has_enterprise_absorb_creation_proof"(NEW."id") THEN
    RETURN NEW;
  END IF;
  PERFORM "assert_balance_grant_funding_aggregate"(NEW."id");
  RETURN NEW;
END
$$;

COMMIT;
