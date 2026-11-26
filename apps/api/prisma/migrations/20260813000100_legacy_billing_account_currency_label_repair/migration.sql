-- Install-only release for one proven legacy USD -> CNY label correction.
-- `prisma migrate deploy` never changes account data.  The exact manifest can
-- be applied only by the controlled function installed at the end of this
-- file, during a drained maintenance window and with database-bound evidence.

-- BillingAccount.currency is a deployment-owned identity decision. The
-- historical USD default created the cohort repaired by this release and can
-- silently recreate it from any future writer that omits currency. All live
-- provisioning paths now provide the resolved deployment currency explicitly;
-- fail closed at INSERT for every other path.
ALTER TABLE "billing_accounts"
  ALTER COLUMN "currency" DROP DEFAULT;

CREATE TABLE "billing_account_currency_label_repair_runs" (
  "id" TEXT NOT NULL,
  "manifest_version" TEXT NOT NULL,
  "manifest_hash" TEXT NOT NULL,
  "database_name" TEXT NOT NULL,
  "database_identity" UUID NOT NULL,
  "database_system_identifier" NUMERIC(20, 0) NOT NULL,
  "database_oid" BIGINT NOT NULL,
  "source_currency" TEXT NOT NULL,
  "target_currency" TEXT NOT NULL,
  "platform_config_snapshot" JSONB NOT NULL,
  "platform_config_hash" TEXT NOT NULL,
  "change_ticket" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "approver_one" TEXT NOT NULL,
  "approver_two" TEXT NOT NULL,
  "evidence_sha256" TEXT NOT NULL,
  "confirmation" TEXT NOT NULL,
  "writers_drained_until" TIMESTAMP(3) NOT NULL,
  "account_count" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "applied_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_account_currency_label_repair_runs_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "billing_account_currency_label_repair_runs_contract_check"
    CHECK (
      "manifest_version" ~ '^[a-z0-9][a-z0-9._-]{2,127}$'
      AND "manifest_hash" ~ '^[0-9a-f]{64}$'
      AND "source_currency" ~ '^[A-Z]{3}$'
      AND "target_currency" ~ '^[A-Z]{3}$'
      AND "source_currency" <> "target_currency"
      AND jsonb_typeof("platform_config_snapshot") = 'object'
      AND NULLIF(btrim("platform_config_snapshot"->>'region'), '') IS NOT NULL
      AND upper("platform_config_snapshot"->>'currency') = "target_currency"
      AND "platform_config_hash" ~ '^[0-9a-f]{64}$'
      AND NULLIF(btrim("change_ticket"), '') IS NOT NULL
      AND NULLIF(btrim("operator"), '') IS NOT NULL
      AND NULLIF(btrim("approver_one"), '') IS NOT NULL
      AND NULLIF(btrim("approver_two"), '') IS NOT NULL
      AND lower(btrim("operator")) <> lower(btrim("approver_one"))
      AND lower(btrim("operator")) <> lower(btrim("approver_two"))
      AND lower(btrim("approver_one")) <> lower(btrim("approver_two"))
      AND "evidence_sha256" ~ '^[0-9a-f]{64}$'
      AND "evidence_sha256" <> repeat('0', 64)
      AND "confirmation" = 'LABEL_ONLY_NO_FX'
      AND "writers_drained_until" >= "applied_at" + INTERVAL '15 minutes'
      AND "account_count" > 0
      AND "status" = 'APPLIED'
      AND "created_at" = "applied_at"
    )
);

CREATE UNIQUE INDEX "billing_account_currency_label_repair_runs_manifest_key"
  ON "billing_account_currency_label_repair_runs"("manifest_version");

CREATE TABLE "billing_account_currency_label_repair_items" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "before_currency" TEXT NOT NULL,
  "after_currency" TEXT NOT NULL,
  "before_account_snapshot" JSONB NOT NULL,
  "before_account_snapshot_hash" TEXT NOT NULL,
  "after_account_snapshot" JSONB NOT NULL,
  "after_account_snapshot_hash" TEXT NOT NULL,
  "financial_snapshot" JSONB NOT NULL,
  "financial_snapshot_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_account_currency_label_repair_items_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "billing_account_currency_label_repair_items_run_fkey"
    FOREIGN KEY ("run_id")
    REFERENCES "billing_account_currency_label_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_account_currency_label_repair_items_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_account_currency_label_repair_items_contract_check"
    CHECK (
      "ordinal" > 0
      AND "before_currency" ~ '^[A-Z]{3}$'
      AND "after_currency" ~ '^[A-Z]{3}$'
      AND "before_currency" <> "after_currency"
      AND jsonb_typeof("before_account_snapshot") = 'object'
      AND jsonb_typeof("after_account_snapshot") = 'object'
      AND jsonb_typeof("financial_snapshot") = 'object'
      AND "before_account_snapshot_hash" ~ '^[0-9a-f]{64}$'
      AND "after_account_snapshot_hash" ~ '^[0-9a-f]{64}$'
      AND "financial_snapshot_hash" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX
  "billing_account_currency_label_repair_items_account_key"
  ON "billing_account_currency_label_repair_items"("billing_account_id");
CREATE UNIQUE INDEX
  "billing_account_currency_label_repair_items_run_ordinal_key"
  ON "billing_account_currency_label_repair_items"("run_id", "ordinal");
CREATE UNIQUE INDEX
  "billing_account_currency_label_repair_items_run_account_key"
  ON "billing_account_currency_label_repair_items"(
    "run_id", "billing_account_id"
  );

CREATE TABLE "billing_account_currency_label_repair_eligible_events" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "evidence_id" TEXT NOT NULL,
  "evidence_hash" TEXT NOT NULL,
  "failure_code" TEXT NOT NULL,
  "failure_reason" TEXT NOT NULL,
  "error_message" TEXT NOT NULL,
  "error_fingerprint" TEXT NOT NULL,
  "event_snapshot" JSONB NOT NULL,
  "row_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_currency_repair_events_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "billing_currency_repair_events_run_fkey"
    FOREIGN KEY ("run_id")
    REFERENCES "billing_account_currency_label_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_currency_repair_events_item_fkey"
    FOREIGN KEY ("item_id")
    REFERENCES "billing_account_currency_label_repair_items"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_currency_repair_events_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id")
    REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_currency_repair_events_evidence_fkey"
    FOREIGN KEY ("evidence_id")
    REFERENCES "gateway_usage_evidences"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_currency_repair_events_contract_check"
    CHECK (
      "evidence_hash" ~ '^[0-9a-f]{64}$'
      AND "failure_code" = 'BILLING_CURRENCY_MIGRATION_REQUIRED'
      AND "failure_reason" = 'settlement_anchor_missing'
      AND "error_message"
        = 'Gateway billing currency mismatch: account=USD deployment=CNY'
      AND "error_fingerprint"
        = 'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137'
      AND jsonb_typeof("event_snapshot") = 'object'
      AND "row_hash" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX
  "billing_currency_repair_events_event_key"
  ON "billing_account_currency_label_repair_eligible_events"(
    "gateway_billing_event_id"
  );
CREATE UNIQUE INDEX
  "billing_currency_repair_events_request_key"
  ON "billing_account_currency_label_repair_eligible_events"("request_id");
CREATE UNIQUE INDEX
  "billing_currency_repair_events_evidence_key"
  ON "billing_account_currency_label_repair_eligible_events"("evidence_id");
CREATE UNIQUE INDEX
  "billing_currency_repair_events_run_event_key"
  ON "billing_account_currency_label_repair_eligible_events"(
    "run_id", "gateway_billing_event_id"
  );
CREATE UNIQUE INDEX
  "billing_currency_repair_events_item_event_key"
  ON "billing_account_currency_label_repair_eligible_events"(
    "item_id", "gateway_billing_event_id"
  );

COMMENT ON COLUMN
  "billing_account_currency_label_repair_eligible_events"."failure_code"
  IS 'Migration eligibility classification; not a historical Gateway event field.';
COMMENT ON COLUMN
  "billing_account_currency_label_repair_eligible_events"."failure_reason"
  IS 'Exact historical gateway_billing_events.reason captured before repair.';
COMMENT ON COLUMN
  "billing_account_currency_label_repair_eligible_events"."error_fingerprint"
  IS 'SHA-256 of the exact historical gateway_billing_events.error_message.';

CREATE OR REPLACE FUNCTION
  "reject_billing_account_currency_label_repair_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'billing account currency label repair audit is append-only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER "billing_account_currency_label_repair_runs_append_only"
  BEFORE UPDATE OR DELETE ON "billing_account_currency_label_repair_runs"
  FOR EACH ROW
  EXECUTE FUNCTION
    "reject_billing_account_currency_label_repair_audit_mutation"();

CREATE TRIGGER "billing_account_currency_label_repair_items_append_only"
  BEFORE UPDATE OR DELETE ON "billing_account_currency_label_repair_items"
  FOR EACH ROW
  EXECUTE FUNCTION
    "reject_billing_account_currency_label_repair_audit_mutation"();

CREATE TRIGGER "billing_account_currency_label_repair_events_append_only"
  BEFORE UPDATE OR DELETE
  ON "billing_account_currency_label_repair_eligible_events"
  FOR EACH ROW
  EXECUTE FUNCTION
    "reject_billing_account_currency_label_repair_audit_mutation"();

-- Install the narrow exception before the controlled function can be called.
-- The trigger itself remains attached throughout the operation: it accepts
-- only a USD -> CNY row whose exact OLD/NEW snapshots already exist under the
-- transaction-local, append-only repair run.  There is no unguarded window.
CREATE OR REPLACE FUNCTION enforce_billing_account_currency_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_run_id TEXT;
BEGIN
  IF NEW."currency" IS NOT DISTINCT FROM OLD."currency" THEN
    RETURN NEW;
  END IF;
  active_run_id := NULLIF(btrim(current_setting(
    'billing.currency_label_repair_run_id', TRUE
  )), '');
  IF OLD."currency" = 'USD'
    AND NEW."currency" = 'CNY'
    AND active_run_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_repair_runs" repair_run
      JOIN "billing_account_currency_label_repair_items" item
        ON item."run_id" = repair_run."id"
      WHERE repair_run."id" = active_run_id
        AND (
          repair_run."manifest_version"
            = 'shanghai-uat-legacy-usd-label-v1'
          OR (
            lower(current_database()) ~ '(test|ci)'
            AND COALESCE(NULLIF(current_setting(
              'billing.allow_currency_label_repair_fixture', TRUE
            ), ''), 'false')::BOOLEAN
          )
        )
        AND repair_run."status" = 'APPLIED'
        AND repair_run."source_currency" = 'USD'
        AND repair_run."target_currency" = 'CNY'
        AND item."billing_account_id" = OLD."id"
        AND item."before_currency" = 'USD'
        AND item."after_currency" = 'CNY'
        AND item."before_account_snapshot" = to_jsonb(OLD)
        AND item."after_account_snapshot" = to_jsonb(NEW)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'billing account currency requires a drained dedicated migration'
    USING ERRCODE = '55000';
END
$$;

-- Stable, sorted evidence deliberately excludes the account currency field.
-- The same JSONB/hash must survive the label update byte-for-byte, proving
-- that no wallet, grant, debt, transaction, receipt, order or identity fact
-- was converted or rewritten by this operation.
CREATE OR REPLACE FUNCTION
  "billing_account_currency_label_financial_snapshot"(
    target_account_id TEXT
  )
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'accountIdentity', to_jsonb(account_row)
      - 'currency' - 'updated_at',
    'wallet', COALESCE((
      SELECT to_jsonb(wallet_row)
      FROM "account_wallets" wallet_row
      WHERE wallet_row."billing_account_id" = target_account_id
    ), 'null'::JSONB),
    'tenants', COALESCE((
      SELECT jsonb_agg(to_jsonb(tenant_row) ORDER BY tenant_row."id")
      FROM "tenants" tenant_row
      WHERE tenant_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'apiKeys', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(api_key_row)
          - 'key_hash'
          - 'provision_secret_encrypted'
        ORDER BY api_key_row."id"
      )
      FROM "api_keys" api_key_row
      JOIN "tenants" tenant_row
        ON tenant_row."id" = api_key_row."tenant_id"
      WHERE tenant_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'orders', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(order_row)
          - 'checkout_context_encrypted'
          - 'checkout_pay_url_encrypted'
        ORDER BY order_row."id"
      )
      FROM "orders" order_row
      WHERE order_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'orderItems', COALESCE((
      SELECT jsonb_agg(to_jsonb(item_row) ORDER BY item_row."id")
      FROM "order_items" item_row
      JOIN "orders" order_row ON order_row."id" = item_row."order_id"
      WHERE order_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'orderAuditLogs', COALESCE((
      SELECT jsonb_agg(to_jsonb(audit_row) ORDER BY audit_row."id")
      FROM "order_audit_logs" audit_row
      JOIN "orders" order_row ON order_row."id" = audit_row."order_id"
      WHERE order_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'balanceTransactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(transaction_row) ORDER BY transaction_row."id")
      FROM "balance_transactions" transaction_row
      WHERE transaction_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'balanceGrants', COALESCE((
      SELECT jsonb_agg(to_jsonb(grant_row) ORDER BY grant_row."id")
      FROM "balance_grants" grant_row
      WHERE grant_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'balanceAllocations', COALESCE((
      SELECT jsonb_agg(to_jsonb(allocation_row) ORDER BY allocation_row."id")
      FROM "balance_consumption_allocations" allocation_row
      WHERE allocation_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'enterpriseSettlements', COALESCE((
      SELECT jsonb_agg(to_jsonb(settlement_row) ORDER BY settlement_row."id")
      FROM "enterprise_credit_settlements" settlement_row
      WHERE settlement_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'balanceGrantsExpiries', COALESCE((
      SELECT jsonb_agg(to_jsonb(expiry_row) ORDER BY expiry_row."id")
      FROM "balance_grant_expiries" expiry_row
      WHERE expiry_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'balanceGrantRefunds', COALESCE((
      SELECT jsonb_agg(to_jsonb(refund_row) ORDER BY refund_row."id")
      FROM "balance_grant_refunds" refund_row
      WHERE refund_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'balanceGrantRefundAllocations', COALESCE((
      SELECT jsonb_agg(to_jsonb(allocation_row)
        ORDER BY allocation_row."refund_id", allocation_row."sequence")
      FROM "balance_grant_refund_allocations" allocation_row
      JOIN "balance_grant_refunds" refund_row
        ON refund_row."id" = allocation_row."refund_id"
      WHERE refund_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'creditTransactions', COALESCE((
      SELECT jsonb_agg(to_jsonb(credit_row) ORDER BY credit_row."id")
      FROM "credit_transactions" credit_row
      LEFT JOIN "tenants" credit_tenant
        ON credit_tenant."id" = credit_row."tenant_id"
      WHERE credit_tenant."billing_account_id" = target_account_id
        OR EXISTS (
          SELECT 1
          FROM "gateway_billing_events" credit_event
          LEFT JOIN "api_keys" credit_event_key
            ON credit_event_key."id" = credit_event."api_key_id"
          LEFT JOIN "tenants" credit_event_tenant
            ON credit_event_tenant."id" = credit_event_key."tenant_id"
          WHERE credit_event."request_id" = credit_row."request_id"
            AND (
              credit_event."billing_account_id" = target_account_id
              OR credit_event_tenant."billing_account_id" = target_account_id
            )
        )
    ), '[]'::JSONB),
    'creditConfig', COALESCE((
      SELECT to_jsonb(config_row)
      FROM "billing_account_credit_configs" config_row
      WHERE config_row."billing_account_id" = target_account_id
    ), 'null'::JSONB),
    'creditEvents', COALESCE((
      SELECT jsonb_agg(to_jsonb(event_row)
        ORDER BY event_row."created_at", event_row."id")
      FROM "billing_account_credit_events" event_row
      WHERE event_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'settlementAnchors', COALESCE((
      SELECT jsonb_agg(to_jsonb(anchor_row) ORDER BY anchor_row."id")
      FROM "gateway_usage_settlement_anchors" anchor_row
      WHERE anchor_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'fundingReservations', COALESCE((
      SELECT jsonb_agg(to_jsonb(reservation_row) ORDER BY reservation_row."id")
      FROM "gateway_usage_funding_reservations" reservation_row
      WHERE reservation_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'fundingReservationGrants', COALESCE((
      SELECT jsonb_agg(to_jsonb(grant_row)
        ORDER BY grant_row."funding_reservation_id",
          grant_row."allocation_order")
      FROM "gateway_usage_funding_reservation_grants" grant_row
      JOIN "gateway_usage_funding_reservations" reservation_row
        ON reservation_row."id" = grant_row."funding_reservation_id"
      WHERE reservation_row."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'settlementReceipts', COALESCE((
      SELECT jsonb_agg(to_jsonb(receipt_row) ORDER BY receipt_row."id")
      FROM "gateway_usage_settlement_receipts" receipt_row
      JOIN "gateway_billing_events" receipt_event
        ON receipt_event."id" = receipt_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" receipt_api_key
        ON receipt_api_key."id" = receipt_event."api_key_id"
      LEFT JOIN "tenants" receipt_api_key_tenant
        ON receipt_api_key_tenant."id" = receipt_api_key."tenant_id"
      WHERE receipt_event."billing_account_id" = target_account_id
        OR receipt_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'gatewayBillingEvents', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(event_row)
          - 'raw_event'
          - 'billing_result'
          - 'subject_snapshot'
          - 'pricing_snapshot'
        ORDER BY event_row."id"
      )
      FROM "gateway_billing_events" event_row
      LEFT JOIN "api_keys" event_api_key
        ON event_api_key."id" = event_row."api_key_id"
      LEFT JOIN "tenants" event_api_key_tenant
        ON event_api_key_tenant."id" = event_api_key."tenant_id"
      WHERE event_row."billing_account_id" = target_account_id
        OR event_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'tokenUsages', COALESCE((
      SELECT jsonb_agg(to_jsonb(usage_row) ORDER BY usage_row."id")
      FROM "token_usage" usage_row
      JOIN "api_keys" usage_api_key
        ON usage_api_key."id" = usage_row."api_key_id"
      JOIN "tenants" usage_tenant
        ON usage_tenant."id" = usage_api_key."tenant_id"
      WHERE usage_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'gatewayUsageEvidences', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(evidence_row) - 'raw_evidence'
        ORDER BY evidence_row."id"
      )
      FROM "gateway_usage_evidences" evidence_row
      JOIN "gateway_billing_events" event_row
        ON event_row."id" = evidence_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" event_api_key
        ON event_api_key."id" = event_row."api_key_id"
      LEFT JOIN "tenants" event_api_key_tenant
        ON event_api_key_tenant."id" = event_api_key."tenant_id"
      WHERE event_row."billing_account_id" = target_account_id
        OR event_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'gatewayReconciliationActions', COALESCE((
      SELECT jsonb_agg(to_jsonb(action_row) ORDER BY action_row."id")
      FROM "gateway_usage_reconciliation_actions" action_row
      JOIN "gateway_billing_events" event_row
        ON event_row."id" = action_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" event_api_key
        ON event_api_key."id" = event_row."api_key_id"
      LEFT JOIN "tenants" event_api_key_tenant
        ON event_api_key_tenant."id" = event_api_key."tenant_id"
      WHERE event_row."billing_account_id" = target_account_id
        OR event_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'gatewayPlatformLosses', COALESCE((
      SELECT jsonb_agg(to_jsonb(loss_row) ORDER BY loss_row."id")
      FROM "gateway_usage_platform_losses" loss_row
      JOIN "gateway_billing_events" event_row
        ON event_row."id" = loss_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" event_api_key
        ON event_api_key."id" = event_row."api_key_id"
      LEFT JOIN "tenants" event_api_key_tenant
        ON event_api_key_tenant."id" = event_api_key."tenant_id"
      WHERE event_row."billing_account_id" = target_account_id
        OR event_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'usageLossRecognitionClaims', COALESCE((
      SELECT jsonb_agg(to_jsonb(claim_row) ORDER BY claim_row."id")
      FROM "usage_loss_recognition_claims" claim_row
      LEFT JOIN "gateway_usage_platform_losses" loss_row
        ON loss_row."id" = claim_row."gateway_usage_platform_loss_id"
      LEFT JOIN "historical_platform_loss_lines" historical_line
        ON historical_line."id" = claim_row."historical_batch_line_id"
      JOIN "gateway_billing_events" event_row
        ON event_row."id" = COALESCE(
          claim_row."gateway_billing_event_id",
          loss_row."gateway_billing_event_id",
          historical_line."gateway_billing_event_id"
        )
      LEFT JOIN "api_keys" event_api_key
        ON event_api_key."id" = event_row."api_key_id"
      LEFT JOIN "tenants" event_api_key_tenant
        ON event_api_key_tenant."id" = event_api_key."tenant_id"
      WHERE event_row."billing_account_id" = target_account_id
        OR event_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'historicalPlatformLossLines', COALESCE((
      SELECT jsonb_agg(
        to_jsonb(line_row) - 'source_evidence'
        ORDER BY line_row."id"
      )
      FROM "historical_platform_loss_lines" line_row
      JOIN "gateway_billing_events" event_row
        ON event_row."id" = line_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" event_api_key
        ON event_api_key."id" = event_row."api_key_id"
      LEFT JOIN "tenants" event_api_key_tenant
        ON event_api_key_tenant."id" = event_api_key."tenant_id"
      WHERE event_row."billing_account_id" = target_account_id
        OR event_api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'accessRestrictions', COALESCE((
      SELECT jsonb_agg(to_jsonb(restriction_row) ORDER BY restriction_row."id")
      FROM "billing_access_restrictions" restriction_row
      LEFT JOIN "gateway_billing_events" event_row
        ON event_row."id" = restriction_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" api_key_row
        ON api_key_row."id" = restriction_row."api_key_id"
      LEFT JOIN "tenants" api_key_tenant
        ON api_key_tenant."id" = api_key_row."tenant_id"
      WHERE restriction_row."billing_account_id" = target_account_id
        OR event_row."billing_account_id" = target_account_id
        OR api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB),
    'restrictionProjectionIntents', COALESCE((
      SELECT jsonb_agg(to_jsonb(intent_row) ORDER BY intent_row."id")
      FROM "billing_restriction_projection_intents" intent_row
      JOIN "billing_access_restrictions" restriction_row
        ON restriction_row."id"
          = intent_row."billing_access_restriction_id"
      LEFT JOIN "gateway_billing_events" event_row
        ON event_row."id" = restriction_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" api_key_row
        ON api_key_row."id" = restriction_row."api_key_id"
      LEFT JOIN "tenants" api_key_tenant
        ON api_key_tenant."id" = api_key_row."tenant_id"
      WHERE restriction_row."billing_account_id" = target_account_id
        OR event_row."billing_account_id" = target_account_id
        OR api_key_tenant."billing_account_id" = target_account_id
    ), '[]'::JSONB)
  )
  FROM "billing_accounts" account_row
  WHERE account_row."id" = target_account_id
$$;

CREATE OR REPLACE FUNCTION "billing_account_currency_label_manifest_v1"()
RETURNS TABLE(ordinal INTEGER, billing_account_id TEXT)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (1, 'ba_personal_13040ccb-5256-44d2-937f-423c661031be'),
    (2, 'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302'),
    (3, 'ba_personal_63b7b465-c3c0-48a8-92d1-5e5ab6067143'),
    (4, '30063f69-bcf2-4986-a1dc-fe06a75af051'),
    (5, 'ba_personal_cc7dc530-6a4a-4cc1-9635-f7e1697d7b08'),
    (6, 'ba_personal_5136b962-258d-4931-9a18-3f6ea1b33057'),
    (7, 'ba_personal_4f94a2e3-9c40-4bcc-a87b-99bd16bc9465'),
    (8, 'ba_personal_413aeb0e-d1ac-481d-b955-d95e4116d1c6'),
    (9, 'ba_personal_7bf7094a-220e-4e37-aa5c-92dfd682afcd'),
    (10, 'ba_personal_7356826b-a83c-46c1-8738-302c547b7059')
$$;

CREATE OR REPLACE FUNCTION "billing_account_currency_label_pending_order_v1"()
RETURNS TABLE(
  order_id TEXT,
  billing_account_id TEXT,
  order_type TEXT,
  amount_cents INTEGER,
  currency TEXT,
  channel TEXT,
  created_at TIMESTAMP(3)
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (
      '9d2903d9-7475-4f02-af74-3f61c8cc3c55',
      '30063f69-bcf2-4986-a1dc-fe06a75af051',
      'RECHARGE', 500, 'cny', 'ALIPAY',
      TIMESTAMP '2026-08-05 06:40:18.197'
    ),
    (
      '88805844-5b2e-4659-a2da-a5fd9623cd57',
      'ba_personal_cc7dc530-6a4a-4cc1-9635-f7e1697d7b08',
      'SUBSCRIPTION', 47700, 'cny', 'ALIPAY',
      TIMESTAMP '2026-08-07 07:03:27.420'
    ),
    (
      'e26322b8-b865-43f9-a654-8b215c23c695',
      'ba_personal_cc7dc530-6a4a-4cc1-9635-f7e1697d7b08',
      'SUBSCRIPTION', 47700, 'cny', 'ALIPAY',
      TIMESTAMP '2026-08-07 07:11:58.734'
    )
$$;

CREATE OR REPLACE FUNCTION "billing_account_currency_label_event_v1"()
RETURNS TABLE(
  ordinal INTEGER,
  gateway_billing_event_id TEXT,
  request_id TEXT,
  event_id TEXT,
  evidence_id TEXT,
  evidence_hash TEXT,
  api_key_id TEXT,
  tenant_id TEXT,
  billing_account_id TEXT,
  evidence_revision INTEGER,
  evidence_source TEXT,
  evidence_status TEXT,
  evidence_protocol TEXT,
  terminal_frame_seen BOOLEAN,
  provider_reconciliation_required BOOLEAN,
  event_created_at TIMESTAMP(3),
  evidence_created_at TIMESTAMP(3),
  expected_snapshot_hash TEXT
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (
      1,
      '9ee64264-8af5-4069-ba27-21c9abfe85d3',
      '5d293fa0-5535-461e-84ca-f6cdbc5b6f79',
      '0ee4f429-48b3-4046-80c5-b238c327f6a4',
      '2ae0ea4d-43eb-4f82-a998-51694f442b1b',
      '3333974d9ae04d29014bb6da9d5d70ae955a8799445ed20cf33d73bb9f6dab68',
      'b3a7a31e-c468-4c74-b018-6aea2fb03761',
      'e6afdaf1-1aab-45fa-9591-9714a787d9d2',
      'ba_personal_13040ccb-5256-44d2-937f-423c661031be',
      1, 'provider_terminal', 'complete', 'openai', FALSE, FALSE,
      TIMESTAMP '2026-08-13 03:39:38.154',
      TIMESTAMP '2026-08-13 03:39:38.166',
      '39915d88e321933de7ec9de8da2ddb439dfaea912ec54bb5ec494eef0c4baba1'
    ),
    (
      2,
      'b14d60c2-209d-4335-b28c-ecd55727584e',
      'fa5f8903-eba4-4f49-902c-778b7990170e',
      'bb4cc7a4-1bdd-4103-9bb8-d7815f024037',
      '8d5f551d-59d0-46f9-8a61-bf81469df9c3',
      '1a2bed3da4e2e81e1359e563fc5e24c5fee13ecf01b833adc0d97c6d8fceb240',
      '5762506d-013e-4edb-b95c-486906f52036',
      'e6afdaf1-1aab-45fa-9591-9714a787d9d2',
      'ba_personal_13040ccb-5256-44d2-937f-423c661031be',
      1, 'provider_terminal', 'complete', 'openai', FALSE, FALSE,
      TIMESTAMP '2026-08-13 03:34:25.227',
      TIMESTAMP '2026-08-13 03:34:25.239',
      'e105b4a9d559a15a177f4b0b73da997e4dca0be26b74612645a1b023ae373208'
    ),
    (
      3,
      'd49e5d2e-3241-45e1-9d64-1ec1095bdd71',
      'fe1c94d3-61b2-46c5-97a9-a690a2771bca',
      '8a3b4511-cb5c-41d3-8ae2-6e119c81bd9c',
      'f35c4c9c-b388-40b2-af26-abacb7edc980',
      '9b8a3b7dd53e3e8afbf7f92afcad3a6c65d16a02061ecbb521d268671bf51e9a',
      '5762506d-013e-4edb-b95c-486906f52036',
      'e6afdaf1-1aab-45fa-9591-9714a787d9d2',
      'ba_personal_13040ccb-5256-44d2-937f-423c661031be',
      1, 'gateway_estimate', 'missing', 'openai', FALSE, TRUE,
      TIMESTAMP '2026-08-13 03:33:10.287',
      TIMESTAMP '2026-08-13 03:33:10.300',
      '0f0c06835a7282cae1ef73c37ace6a42834800906356b2f14424c82b4bdc4457'
    )
$$;

CREATE OR REPLACE FUNCTION "billing_account_currency_label_failed_usd_order_v1"()
RETURNS TABLE(
  order_id TEXT,
  billing_account_id TEXT,
  order_type TEXT,
  amount_cents INTEGER,
  currency TEXT,
  channel TEXT,
  created_at TIMESTAMP(3)
)
LANGUAGE sql
IMMUTABLE
AS $$
  VALUES
    (
      'd7f69988-6e0f-4846-a5f1-ccf73bf36120',
      'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302',
      'SUBSCRIPTION', 10000, 'usd', 'STRIPE',
      TIMESTAMP '2026-07-06 11:05:44.890'
    ),
    (
      '5b539709-a86a-41a3-9b70-24ebd5313842',
      'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302',
      'SUBSCRIPTION', 10000, 'usd', 'STRIPE',
      TIMESTAMP '2026-07-06 11:07:53.552'
    ),
    (
      'cd9b3093-370f-4f5a-b275-778ed3d8c1e9',
      'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302',
      'SUBSCRIPTION', 10000, 'usd', 'STRIPE',
      TIMESTAMP '2026-07-06 11:42:37.464'
    ),
    (
      '46d3b296-4edb-4840-b919-92b5f3c5a7c0',
      'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302',
      'SUBSCRIPTION', 10000, 'usd', 'STRIPE',
      TIMESTAMP '2026-07-06 11:42:45.410'
    ),
    (
      '13104bac-adee-4aa1-9136-ebace216e03c',
      'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302',
      'SUBSCRIPTION', 10000, 'usd', 'STRIPE',
      TIMESTAMP '2026-07-06 11:44:49.640'
    ),
    (
      '6c2fd97f-c92b-4756-aedb-146351ff4402',
      'ba_personal_ba66f579-b27c-49eb-8f29-784c27307302',
      'SUBSCRIPTION', 10000, 'usd', 'STRIPE',
      TIMESTAMP '2026-07-06 11:50:47.574'
    )
$$;

-- A read-only, database-bound evidence envelope.  Operators preserve this
-- JSON/hash before entering the write function; the write path recomputes it
-- under SHARE locks and rejects any intervening identity or financial change.
CREATE OR REPLACE FUNCTION "billing_account_currency_label_evidence_v1"()
RETURNS TABLE(
  manifest_hash TEXT,
  evidence_snapshot JSONB,
  evidence_sha256 TEXT
)
LANGUAGE sql
STABLE
AS $$
  WITH manifest_rows AS (
    SELECT manifest.ordinal, manifest.billing_account_id,
      to_jsonb(account_row) AS account_snapshot,
      "billing_account_currency_label_financial_snapshot"(
        manifest.billing_account_id
      ) AS financial_snapshot
    FROM "billing_account_currency_label_manifest_v1"() manifest
    LEFT JOIN "billing_accounts" account_row
      ON account_row."id" = manifest.billing_account_id
  ), manifest_evidence AS (
    SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
        'ordinal', manifest.ordinal,
        'billingAccountId', manifest.billing_account_id,
        'type', account_row."type",
        'createdAt', to_char(
          account_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'
        ),
        'ledgerStatus', account_row."balance_grant_ledger_status",
        'ledgerVersion', account_row."balance_grant_ledger_version"
      ) ORDER BY manifest.ordinal), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      AS manifest_hash
    FROM "billing_account_currency_label_manifest_v1"() manifest
    LEFT JOIN "billing_accounts" account_row
      ON account_row."id" = manifest.billing_account_id
  ), evidence AS (
    SELECT jsonb_build_object(
      'manifestVersion', 'shanghai-uat-legacy-usd-label-v1',
      'manifestHash', manifest_evidence.manifest_hash,
      'databaseName', current_database(),
      'databaseIdentity', (
        SELECT rollout."database_identity"::TEXT
        FROM "balance_ledger_rollout_control" rollout
        WHERE rollout."id" = 1
      ),
      'databaseSystemIdentifier', (
        SELECT rollout."database_system_identifier"::TEXT
        FROM "balance_ledger_rollout_control" rollout
        WHERE rollout."id" = 1
      ),
      'databaseOid', (
        SELECT rollout."database_oid"::BIGINT
        FROM "balance_ledger_rollout_control" rollout
        WHERE rollout."id" = 1
      ),
      'deploymentConfig', COALESCE((
        SELECT jsonb_build_object(
          'region', lower(config."value"::JSONB->>'region'),
          'currency', lower(config."value"::JSONB->>'currency')
        )
        FROM "system_configs" config
        WHERE config."key" = 'deploymentConfig'
      ), 'null'::JSONB),
      'accounts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'ordinal', manifest_rows.ordinal,
          'billingAccountId', manifest_rows.billing_account_id,
          'account', manifest_rows.account_snapshot,
          'financial', manifest_rows.financial_snapshot
        ) ORDER BY manifest_rows.ordinal)
        FROM manifest_rows
      ), '[]'::JSONB)
    ) AS snapshot, manifest_evidence.manifest_hash
    FROM manifest_evidence
  )
  SELECT evidence.manifest_hash, evidence.snapshot,
    encode(sha256(convert_to(evidence.snapshot::TEXT, 'UTF8')), 'hex')
  FROM evidence
$$;

CREATE OR REPLACE FUNCTION
  "apply_legacy_billing_account_currency_label_repair_v1"(
    expected_database_name TEXT,
    expected_database_identity UUID,
    expected_manifest_hash TEXT,
    requested_change_ticket TEXT,
    requested_operator TEXT,
    requested_approver_one TEXT,
    requested_approver_two TEXT,
    requested_evidence_sha256 TEXT,
    requested_confirmation TEXT,
    requested_writers_drained_until TIMESTAMP(3)
  )
RETURNS TABLE(
  run_id TEXT,
  manifest_version TEXT,
  status TEXT,
  account_count INTEGER,
  applied_at TIMESTAMP(3)
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_manifest_version CONSTANT TEXT :=
    'shanghai-uat-legacy-usd-label-v1';
  target_manifest_hash CONSTANT TEXT :=
    '1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6';
  source_currency CONSTANT TEXT := 'USD';
  target_currency CONSTANT TEXT := 'CNY';
  expected_account_count CONSTANT INTEGER := 10;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
  rollout_control RECORD;
  deployment_config JSONB;
  deployment_config_hash TEXT;
  actual_manifest_hash TEXT;
  actual_evidence_snapshot JSONB;
  actual_evidence_sha256 TEXT;
  manifest_match_count BIGINT;
  pending_order_count BIGINT;
  non_cny_financial_order_count BIGINT;
  non_cny_order_count BIGINT;
  non_cny_unproven_order_count BIGINT;
  active_financial_order_count BIGINT;
  invalid_repair_count BIGINT;
  invalid_anchor_count BIGINT;
  eligible_event_count BIGINT;
  existing_run "billing_account_currency_label_repair_runs"%ROWTYPE;
  operation_run_id TEXT;
  operation_at TIMESTAMP(3);
  manifest_row RECORD;
  eligible_event_row RECORD;
  eligible_event_snapshot JSONB;
  eligible_event_row_hash TEXT;
  account_before JSONB;
  account_after JSONB;
  financial_before JSONB;
  financial_after JSONB;
  previous_transition_marker TEXT;
BEGIN
  IF expected_database_name IS NULL
    OR btrim(expected_database_name) = ''
    OR expected_database_name IS DISTINCT FROM current_database()
    OR expected_database_identity IS NULL
    OR expected_manifest_hash IS NULL
    OR expected_manifest_hash !~ '^[0-9a-f]{64}$'
    OR NULLIF(btrim(requested_change_ticket), '') IS NULL
    OR NULLIF(btrim(requested_operator), '') IS NULL
    OR NULLIF(btrim(requested_approver_one), '') IS NULL
    OR NULLIF(btrim(requested_approver_two), '') IS NULL
    OR lower(btrim(requested_operator)) = lower(btrim(requested_approver_one))
    OR lower(btrim(requested_operator)) = lower(btrim(requested_approver_two))
    OR lower(btrim(requested_approver_one)) = lower(btrim(requested_approver_two))
    OR requested_evidence_sha256 IS NULL
    OR requested_evidence_sha256 !~ '^[0-9a-f]{64}$'
    OR requested_evidence_sha256 = repeat('0', 64)
    OR requested_confirmation IS DISTINCT FROM 'LABEL_ONLY_NO_FX'
    OR requested_writers_drained_until IS NULL
  THEN
    RAISE EXCEPTION 'currency label repair authorization is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();
  SELECT * INTO rollout_control
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1
  FOR SHARE;
  IF NOT FOUND
    OR rollout_control."phase" IS DISTINCT FROM 'V2_CONTRACT'
    OR rollout_control."database_name" IS DISTINCT FROM current_database()
    OR rollout_control."database_identity"
      IS DISTINCT FROM expected_database_identity
    OR rollout_control."database_system_identifier"
      IS DISTINCT FROM current_system_identifier
    OR rollout_control."database_oid" IS DISTINCT FROM current_database_oid
  THEN
    RAISE EXCEPTION 'currency label repair database locator mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO existing_run
  FROM "billing_account_currency_label_repair_runs"
  WHERE "manifest_version" = target_manifest_version;
  IF FOUND THEN
    IF expected_manifest_hash IS DISTINCT FROM target_manifest_hash
      OR existing_run."manifest_hash" IS DISTINCT FROM target_manifest_hash
      OR existing_run."database_name" IS DISTINCT FROM expected_database_name
      OR existing_run."database_identity" IS DISTINCT FROM expected_database_identity
      OR existing_run."change_ticket" IS DISTINCT FROM btrim(requested_change_ticket)
      OR existing_run."operator" IS DISTINCT FROM btrim(requested_operator)
      OR existing_run."approver_one" IS DISTINCT FROM btrim(requested_approver_one)
      OR existing_run."approver_two" IS DISTINCT FROM btrim(requested_approver_two)
      OR existing_run."evidence_sha256" IS DISTINCT FROM requested_evidence_sha256
      OR existing_run."confirmation" IS DISTINCT FROM requested_confirmation
      OR existing_run."writers_drained_until"
        IS DISTINCT FROM requested_writers_drained_until
      OR existing_run."status" IS DISTINCT FROM 'APPLIED'
      OR existing_run."account_count" IS DISTINCT FROM expected_account_count
      OR (SELECT COUNT(*)
          FROM "billing_account_currency_label_repair_items" item
          WHERE item."run_id" = existing_run."id")
        IS DISTINCT FROM expected_account_count::BIGINT
      OR (SELECT COUNT(*)
          FROM "billing_account_currency_label_repair_eligible_events" event
          WHERE event."run_id" = existing_run."id")
        IS DISTINCT FROM 3::BIGINT
      OR EXISTS (
        SELECT 1
        FROM "billing_account_currency_label_repair_items" item
        JOIN "billing_account_currency_label_manifest_v1"() manifest
          ON manifest.billing_account_id = item."billing_account_id"
        JOIN "billing_accounts" account_row
          ON account_row."id" = item."billing_account_id"
        WHERE item."run_id" = existing_run."id"
          AND (
            account_row."currency" IS DISTINCT FROM target_currency
            OR item."ordinal" IS DISTINCT FROM manifest.ordinal
            OR item."before_currency" IS DISTINCT FROM source_currency
            OR item."after_currency" IS DISTINCT FROM target_currency
            OR item."after_account_snapshot" IS DISTINCT FROM jsonb_set(
              item."before_account_snapshot",
              '{currency}', to_jsonb(target_currency)
            )
            OR encode(sha256(convert_to(
              item."before_account_snapshot"::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM item."before_account_snapshot_hash"
            OR encode(sha256(convert_to(
              item."after_account_snapshot"::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM item."after_account_snapshot_hash"
            OR encode(sha256(convert_to(
              item."financial_snapshot"::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM item."financial_snapshot_hash"
          )
      )
      OR EXISTS (
        SELECT 1
        FROM "billing_account_currency_label_repair_eligible_events" eligible
        JOIN "billing_account_currency_label_repair_items" item
          ON item."id" = eligible."item_id"
        JOIN "gateway_billing_events" event_row
          ON event_row."id" = eligible."gateway_billing_event_id"
        JOIN "gateway_usage_evidences" evidence_row
          ON evidence_row."id" = eligible."evidence_id"
        JOIN "api_keys" api_key_row
          ON api_key_row."id" = event_row."api_key_id"
        JOIN "tenants" tenant_row
          ON tenant_row."id" = api_key_row."tenant_id"
        WHERE eligible."run_id" = existing_run."id"
          AND (
            item."run_id" IS DISTINCT FROM existing_run."id"
            OR item."billing_account_id"
              IS DISTINCT FROM tenant_row."billing_account_id"
            OR event_row."request_id" IS DISTINCT FROM eligible."request_id"
            OR event_row."evidence_hash"
              IS DISTINCT FROM eligible."evidence_hash"
            OR evidence_row."gateway_billing_event_id"
              IS DISTINCT FROM event_row."id"
            OR evidence_row."evidence_hash"
              IS DISTINCT FROM eligible."evidence_hash"
            OR encode(sha256(convert_to(
              jsonb_build_object(
                'runId', eligible."run_id",
                'billingAccountId', item."billing_account_id",
                'gatewayBillingEventId', eligible."gateway_billing_event_id",
                'requestId', eligible."request_id",
                'evidenceId', eligible."evidence_id",
                'evidenceHash', eligible."evidence_hash",
                'failureCode', eligible."failure_code",
                'failureReason', eligible."failure_reason",
                'errorMessage', eligible."error_message",
                'errorFingerprint', eligible."error_fingerprint",
                'eventSnapshot', eligible."event_snapshot"
              )::TEXT, 'UTF8'
            )), 'hex') IS DISTINCT FROM eligible."row_hash"
          )
      )
    THEN
      RAISE EXCEPTION 'currency label repair existing terminal proof/authority mismatch'
        USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT existing_run."id", existing_run."manifest_version",
      existing_run."status", existing_run."account_count", existing_run."applied_at";
    RETURN;
  END IF;

  IF requested_writers_drained_until
    < clock_timestamp()::TIMESTAMP(3) + INTERVAL '15 minutes'
  THEN
    RAISE EXCEPTION 'currency label repair writer drain horizon is insufficient'
      USING ERRCODE = '23514';
  END IF;

  -- Lock every table which can establish a financial/order/usage fact for the
  -- manifest.  RowExclusiveLock conflicts with SHARE, so this waits for all
  -- pre-gate writers and rejects new writers until every postcondition commits.
  -- A five-second lock timeout makes a false drain declaration fail closed.
  PERFORM set_config('lock_timeout', '5s', TRUE);
  LOCK TABLE
    "billing_accounts", "account_wallets", "tenants", "api_keys",
    "orders", "order_items", "order_audit_logs",
    "coding_plan_provider_entitlements", "coding_plan_entitlements",
    "coding_plan_renewal_charges", "coding_plan_promo_grants",
    "campaign_redemptions", "discount_code_redemptions",
    "balance_transactions", "balance_grants",
    "balance_consumption_allocations", "enterprise_credit_settlements",
    "balance_grant_expiries", "balance_grant_refunds",
    "balance_grant_refund_allocations", "credit_transactions",
    "billing_account_credit_configs", "billing_account_credit_events",
    "token_usage", "gateway_billing_events", "gateway_usage_evidences",
    "gateway_usage_reconciliation_actions",
    "gateway_usage_platform_losses", "historical_platform_loss_lines",
    "usage_loss_recognition_claims",
    "gateway_usage_settlement_anchors",
    "gateway_usage_funding_reservations",
    "gateway_usage_funding_reservation_grants",
    "gateway_usage_settlement_receipts", "billing_access_restrictions",
    "billing_restriction_projection_intents", "stripe_payment_ledgers",
    "provider_refund_intents", "refund_compensation_tasks",
    "stripe_subscription_cancellation_tasks", "invoice_application_items",
    "balance_ledger_repair_runs", "balance_ledger_repair_accounts",
    "system_configs"
    IN SHARE MODE;

  SELECT "value"::JSONB INTO deployment_config
  FROM "system_configs"
  WHERE "key" = 'deploymentConfig';
  IF deployment_config IS NULL
    OR lower(deployment_config->>'region') IS DISTINCT FROM 'domestic'
    OR lower(deployment_config->>'currency') IS DISTINCT FROM 'cny'
  THEN
    RAISE EXCEPTION 'currency label repair requires domestic CNY deployment config'
      USING ERRCODE = '23514';
  END IF;
  deployment_config := jsonb_build_object(
    'region', lower(deployment_config->>'region'),
    'currency', lower(deployment_config->>'currency')
  );
  deployment_config_hash := encode(
    sha256(convert_to(deployment_config::TEXT, 'UTF8')), 'hex'
  );

  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
      'ordinal', manifest.ordinal,
      'billingAccountId', manifest.billing_account_id,
      'type', account_row."type",
      'createdAt', to_char(account_row."created_at", 'YYYY-MM-DD HH24:MI:SS.MS'),
      'ledgerStatus', account_row."balance_grant_ledger_status",
      'ledgerVersion', account_row."balance_grant_ledger_version"
    ) ORDER BY manifest.ordinal), '[]'::JSONB)::TEXT, 'UTF8')), 'hex'),
    COUNT(account_row."id")
  INTO actual_manifest_hash, manifest_match_count
  FROM "billing_account_currency_label_manifest_v1"() manifest
  LEFT JOIN "billing_accounts" account_row
    ON account_row."id" = manifest.billing_account_id;
  IF manifest_match_count IS DISTINCT FROM expected_account_count::BIGINT
    OR expected_manifest_hash IS DISTINCT FROM target_manifest_hash
    OR actual_manifest_hash IS DISTINCT FROM target_manifest_hash
  THEN
    RAISE EXCEPTION 'currency label repair manifest mismatch count=% hash=%',
      manifest_match_count, COALESCE(actual_manifest_hash, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  SELECT evidence.evidence_snapshot, evidence.evidence_sha256
  INTO actual_evidence_snapshot, actual_evidence_sha256
  FROM "billing_account_currency_label_evidence_v1"() evidence;
  IF actual_evidence_snapshot IS NULL
    OR actual_evidence_sha256 IS DISTINCT FROM requested_evidence_sha256
  THEN
    RAISE EXCEPTION 'currency label repair database evidence mismatch expected=% actual=%',
      requested_evidence_sha256, COALESCE(actual_evidence_sha256, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO manifest_match_count
  FROM "billing_account_currency_label_manifest_v1"() manifest
  JOIN "billing_accounts" account_row
    ON account_row."id" = manifest.billing_account_id
  JOIN "account_wallets" wallet_row
    ON wallet_row."billing_account_id" = account_row."id"
  WHERE account_row."status" = 'active'
    AND account_row."deleted_at" IS NULL
    AND account_row."currency" = source_currency
    AND account_row."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" = 2
    AND account_row."balance_grant_ledger_hash" ~ '^(EMPTY_V2|[0-9a-f]{64})$'
    AND wallet_row."balance_usd" >= 0;
  IF manifest_match_count IS DISTINCT FROM expected_account_count::BIGINT THEN
    RAISE EXCEPTION 'currency label repair account precondition mismatch valid=%',
      manifest_match_count USING ERRCODE = '23514';
  END IF;

  -- Historical balance repair evidence is accepted only when both levels are
  -- terminal.  RUNNING/FAILED/orphaned evidence means the financial snapshot
  -- is not safe to relabel.
  SELECT COUNT(*) INTO invalid_repair_count
  FROM "balance_ledger_repair_accounts" repair_account
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_account."run_id"
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = repair_account."billing_account_id"
  WHERE repair_run."status" IS DISTINCT FROM 'COMPLETED'
    OR repair_account."status" IS DISTINCT FROM 'APPLIED';
  IF invalid_repair_count <> 0 THEN
    RAISE EXCEPTION 'currency label repair has non-terminal ledger repair evidence=%',
      invalid_repair_count USING ERRCODE = '23514';
  END IF;

  -- Existing anchored/reserved/receipted usage would already have a frozen
  -- billing currency. Receipt ownership is derived through its mandatory
  -- GatewayBillingEvent FK; the receipt table itself has no account column.
  SELECT
    (SELECT COUNT(*)
      FROM "gateway_usage_settlement_anchors" anchor_row
      JOIN "billing_account_currency_label_manifest_v1"() manifest
        ON manifest.billing_account_id = anchor_row."billing_account_id")
    + (SELECT COUNT(*)
      FROM "gateway_usage_funding_reservations" reservation_row
      JOIN "billing_account_currency_label_manifest_v1"() manifest
        ON manifest.billing_account_id = reservation_row."billing_account_id")
    + (SELECT COUNT(*)
      FROM "gateway_usage_settlement_receipts" receipt_row
      JOIN "gateway_billing_events" receipt_event
        ON receipt_event."id" = receipt_row."gateway_billing_event_id"
      LEFT JOIN "api_keys" receipt_api_key
        ON receipt_api_key."id" = receipt_event."api_key_id"
      LEFT JOIN "tenants" receipt_api_key_tenant
        ON receipt_api_key_tenant."id" = receipt_api_key."tenant_id"
      JOIN "billing_account_currency_label_manifest_v1"() manifest
        ON manifest.billing_account_id = receipt_event."billing_account_id"
        OR manifest.billing_account_id
          = receipt_api_key_tenant."billing_account_id")
  INTO invalid_anchor_count;
  IF invalid_anchor_count <> 0 THEN
    RAISE EXCEPTION 'currency label repair cohort has frozen gateway currency facts=%',
      invalid_anchor_count USING ERRCODE = '23514';
  END IF;

  -- Only these three already-observed events may use the later zero-value
  -- unanchored terminal. Bind their immutable evidence and exact failure
  -- state now; an account-level repair item is intentionally insufficient.
  SELECT COUNT(*) INTO eligible_event_count
  FROM "billing_account_currency_label_event_v1"() expected
  JOIN "gateway_billing_events" event_row
    ON event_row."id" = expected.gateway_billing_event_id
  JOIN "gateway_usage_evidences" evidence_row
    ON evidence_row."id" = expected.evidence_id
    AND evidence_row."gateway_billing_event_id" = event_row."id"
  JOIN "api_keys" api_key_row
    ON api_key_row."id" = event_row."api_key_id"
  JOIN "tenants" tenant_row
    ON tenant_row."id" = api_key_row."tenant_id"
  WHERE event_row."request_id" = expected.request_id
    AND event_row."event_id" = expected.event_id
    AND event_row."api_key_id" = expected.api_key_id
    AND event_row."tenant_id" = expected.tenant_id
    AND tenant_row."id" = expected.tenant_id
    AND tenant_row."billing_account_id" = expected.billing_account_id
    AND event_row."billing_account_id" IS NULL
    AND event_row."status" = 'QUARANTINED'
    AND event_row."reason" = 'settlement_anchor_missing'
    AND event_row."error_message"
      = 'Gateway billing currency mismatch: account=USD deployment=CNY'
    AND event_row."evidence_hash" = expected.evidence_hash
    AND event_row."evidence_verdict" = 'INCOMPLETE'
    AND event_row."reconciliation_status" = 'MANUAL_REVIEW'
    AND event_row."funding_outcome" IS NULL
    AND event_row."revision" = 1
    AND event_row."pending_exposure_usd" = 0
    AND event_row."pending_hold_usd" = 0
    AND event_row."created_at" = expected.event_created_at
    AND evidence_row."request_id" = expected.request_id
    AND evidence_row."event_id" = expected.event_id
    AND evidence_row."source" = 'GATEWAY_USAGE_EVENT'
    AND evidence_row."evidence_hash" = expected.evidence_hash
    AND evidence_row."evidence_revision" = expected.evidence_revision
    AND evidence_row."usage_evidence_source" = expected.evidence_source
    AND evidence_row."usage_evidence_status" = expected.evidence_status
    AND evidence_row."usage_evidence_protocol" = expected.evidence_protocol
    AND evidence_row."terminal_frame_seen"
      IS NOT DISTINCT FROM expected.terminal_frame_seen
    AND evidence_row."provider_reconciliation_required"
      IS NOT DISTINCT FROM expected.provider_reconciliation_required
    AND evidence_row."created_at" = expected.evidence_created_at
    AND encode(sha256(convert_to(jsonb_build_object(
      'event', to_jsonb(event_row)
        - 'raw_event'
        - 'billing_result'
        - 'subject_snapshot'
        - 'pricing_snapshot',
      'evidence', to_jsonb(evidence_row) - 'raw_evidence',
      'resolvedBillingAccountId', tenant_row."billing_account_id"
    )::TEXT, 'UTF8')), 'hex') = expected.expected_snapshot_hash
    AND NOT EXISTS (SELECT 1
      FROM "gateway_usage_settlement_anchors" anchor_row
      WHERE anchor_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "gateway_usage_funding_reservations" reservation_row
      WHERE reservation_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "gateway_usage_settlement_receipts" receipt_row
      WHERE receipt_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "token_usage" usage_row
      WHERE usage_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "gateway_usage_reconciliation_actions" action_row
      WHERE action_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "gateway_usage_platform_losses" loss_row
      WHERE loss_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "usage_loss_recognition_claims" claim_row
      WHERE claim_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "historical_platform_loss_lines" line_row
      WHERE line_row."gateway_billing_event_id" = event_row."id")
    AND NOT EXISTS (SELECT 1
      FROM "credit_transactions" credit_row
      WHERE credit_row."request_id" = expected.request_id);
  IF eligible_event_count IS DISTINCT FROM 3::BIGINT THEN
    RAISE EXCEPTION 'currency label repair event eligibility mismatch valid=%',
      eligible_event_count USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO pending_order_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE order_row."status"::TEXT = 'PENDING';
  IF pending_order_count <> 3
    OR EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_pending_order_v1"() expected
      LEFT JOIN "orders" order_row ON order_row."id" = expected.order_id
      WHERE order_row."id" IS NULL
        OR order_row."billing_account_id" IS DISTINCT FROM expected.billing_account_id
        OR order_row."status"::TEXT IS DISTINCT FROM 'PENDING'
        OR order_row."order_type"::TEXT IS DISTINCT FROM expected.order_type
        OR order_row."amount_cents" IS DISTINCT FROM expected.amount_cents
        OR order_row."currency" IS DISTINCT FROM expected.currency
        OR order_row."channel"::TEXT IS DISTINCT FROM expected.channel
        OR order_row."created_at" IS DISTINCT FROM expected.created_at
        OR order_row."trade_no" IS NOT NULL
        OR order_row."paid_at" IS NOT NULL
        OR order_row."refunded_at" IS NOT NULL
        OR order_row."expired_at" IS NOT NULL
        OR order_row."completed_at" IS NOT NULL
        OR order_row."cancelled_at" IS NOT NULL
        OR order_row."fulfillment_attempt_id" IS NOT NULL
        OR order_row."fulfillment_claimed_at" IS NOT NULL
        OR order_row."checkout_init_state"::TEXT IS DISTINCT FROM 'READY'
        OR order_row."checkout_lease_id" IS NOT NULL
        OR order_row."checkout_lease_expires_at" IS NOT NULL
        OR order_row."checkout_provider_reference" IS NOT NULL
        OR order_row."checkout_pay_url_encrypted" IS NULL
        OR order_row."checkout_pay_url_expires_at" IS NULL
        OR EXISTS (SELECT 1 FROM "order_audit_logs" audit_row
          WHERE audit_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "order_items" item_row
          WHERE item_row."order_id" = order_row."id"
            AND (item_row."status"::TEXT <> 'PENDING'
              OR item_row."fulfilled_at" IS NOT NULL))
        OR EXISTS (SELECT 1 FROM "balance_transactions" transaction_row
          WHERE transaction_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "balance_grants" grant_row
          WHERE grant_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "stripe_payment_ledgers" stripe_row
          WHERE stripe_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "provider_refund_intents" refund_row
          WHERE refund_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "refund_compensation_tasks" task_row
          WHERE task_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "stripe_subscription_cancellation_tasks" task_row
          WHERE task_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "invoice_application_items" invoice_item
          WHERE invoice_item."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "coding_plan_provider_entitlements" fact_row
          WHERE fact_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "coding_plan_entitlements" fact_row
          WHERE fact_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "coding_plan_renewal_charges" fact_row
          WHERE fact_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "coding_plan_promo_grants" fact_row
          WHERE fact_row."consumed_by_order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "campaign_redemptions" fact_row
          WHERE fact_row."order_id" = order_row."id")
        OR EXISTS (SELECT 1 FROM "discount_code_redemptions" fact_row
          WHERE fact_row."order_id" = order_row."id")
    )
  THEN
    RAISE EXCEPTION 'currency label repair pending order manifest/evidence mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO active_financial_order_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE order_row."status"::TEXT IN (
    'PAID', 'FULFILLING', 'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
    'REFUNDING', 'REFUND_FAILED', 'REFUND_COMPENSATION_FAILED'
  );
  SELECT COUNT(*) INTO non_cny_financial_order_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE order_row."status"::TEXT IN (
    'PAID', 'FULFILLING', 'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
    'COMPLETED', 'REFUNDING', 'REFUNDED', 'REFUND_FAILED',
    'REFUND_COMPENSATION_FAILED'
  ) AND lower(order_row."currency") <> 'cny';
  IF active_financial_order_count <> 0 OR non_cny_financial_order_count <> 0 THEN
    RAISE EXCEPTION 'currency label repair has active/non-CNY financial orders active=% nonCny=%',
      active_financial_order_count, non_cny_financial_order_count
      USING ERRCODE = '23514';
  END IF;

  -- Six old Stripe attempts are retained as failed audit history.  They carry
  -- no provider reference, financial row, fulfilment, refund or invoice fact.
  SELECT COUNT(*) INTO non_cny_order_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  WHERE lower(order_row."currency") <> 'cny';
  SELECT COUNT(*) INTO non_cny_unproven_order_count
  FROM "orders" order_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = order_row."billing_account_id"
  LEFT JOIN "billing_account_currency_label_failed_usd_order_v1"() expected
    ON expected.order_id = order_row."id"
  WHERE lower(order_row."currency") <> 'cny'
    AND (
      expected.order_id IS NULL
      OR order_row."status"::TEXT <> 'FAILED'
      OR order_row."channel"::TEXT <> 'STRIPE'
      OR order_row."currency" IS DISTINCT FROM expected.currency
      OR order_row."billing_account_id"
        IS DISTINCT FROM expected.billing_account_id
      OR order_row."order_type"::TEXT IS DISTINCT FROM expected.order_type
      OR order_row."amount_cents" IS DISTINCT FROM expected.amount_cents
      OR order_row."created_at" IS DISTINCT FROM expected.created_at
      OR order_row."trade_no" IS NOT NULL
      OR order_row."paid_at" IS NOT NULL
      OR order_row."refunded_at" IS NOT NULL
      OR order_row."completed_at" IS NOT NULL
      OR order_row."fulfillment_attempt_id" IS NOT NULL
      OR order_row."fulfillment_claimed_at" IS NOT NULL
      OR order_row."checkout_init_state"::TEXT <> 'NOT_STARTED'
      OR order_row."checkout_lease_id" IS NOT NULL
      OR order_row."checkout_lease_expires_at" IS NOT NULL
      OR order_row."checkout_context_encrypted" IS NOT NULL
      OR order_row."checkout_provider_reference" IS NOT NULL
      OR order_row."checkout_pay_url_encrypted" IS NOT NULL
      OR order_row."checkout_pay_url_expires_at" IS NOT NULL
      OR (SELECT COUNT(*) FROM "order_audit_logs" audit_row
          WHERE audit_row."order_id" = order_row."id") <> 1
      OR EXISTS (SELECT 1 FROM "order_audit_logs" audit_row
        WHERE audit_row."order_id" = order_row."id"
          AND (audit_row."from_status" <> 'PENDING'
            OR audit_row."to_status" <> 'FAILED'))
      OR EXISTS (SELECT 1 FROM "order_items" item_row
        WHERE item_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "balance_transactions" transaction_row
        WHERE transaction_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "balance_grants" grant_row
        WHERE grant_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "stripe_payment_ledgers" stripe_row
        WHERE stripe_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "provider_refund_intents" refund_row
        WHERE refund_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "refund_compensation_tasks" task_row
        WHERE task_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "stripe_subscription_cancellation_tasks" task_row
        WHERE task_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "invoice_application_items" invoice_item
        WHERE invoice_item."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "coding_plan_provider_entitlements" fact_row
        WHERE fact_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "coding_plan_entitlements" fact_row
        WHERE fact_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "coding_plan_renewal_charges" fact_row
        WHERE fact_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "coding_plan_promo_grants" fact_row
        WHERE fact_row."consumed_by_order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "campaign_redemptions" fact_row
        WHERE fact_row."order_id" = order_row."id")
      OR EXISTS (SELECT 1 FROM "discount_code_redemptions" fact_row
        WHERE fact_row."order_id" = order_row."id")
    );
  IF non_cny_order_count <> 6
    OR non_cny_unproven_order_count <> 0
    OR (SELECT COUNT(*) FROM "orders" order_row
        JOIN "billing_account_currency_label_failed_usd_order_v1"() expected
          ON expected.order_id = order_row."id") <> 6
  THEN
    RAISE EXCEPTION 'currency label repair has unproven non-CNY order history=%',
      non_cny_unproven_order_count USING ERRCODE = '23514';
  END IF;

  operation_run_id := gen_random_uuid()::TEXT;
  operation_at := date_trunc(
    'milliseconds', clock_timestamp() AT TIME ZONE 'UTC'
  );
  INSERT INTO "billing_account_currency_label_repair_runs" (
    "id", "manifest_version", "manifest_hash", "database_name",
    "database_identity", "database_system_identifier", "database_oid",
    "source_currency", "target_currency", "platform_config_snapshot",
    "platform_config_hash", "change_ticket", "operator", "approver_one",
    "approver_two", "evidence_sha256", "confirmation",
    "writers_drained_until", "account_count", "status", "applied_at",
    "created_at"
  ) VALUES (
    operation_run_id, target_manifest_version, actual_manifest_hash,
    current_database(), expected_database_identity,
    current_system_identifier, current_database_oid::BIGINT,
    source_currency, target_currency, deployment_config,
    deployment_config_hash, btrim(requested_change_ticket),
    btrim(requested_operator), btrim(requested_approver_one),
    btrim(requested_approver_two), requested_evidence_sha256,
    requested_confirmation, requested_writers_drained_until,
    expected_account_count, 'APPLIED', operation_at, operation_at
  );

  previous_transition_marker := current_setting(
    'billing.currency_label_repair_run_id', TRUE
  );
  PERFORM set_config(
    'billing.currency_label_repair_run_id', operation_run_id, TRUE
  );

  FOR manifest_row IN
    SELECT manifest.ordinal, manifest.billing_account_id
    FROM "billing_account_currency_label_manifest_v1"() manifest
    ORDER BY manifest.ordinal
  LOOP
    SELECT to_jsonb(account_row),
      "billing_account_currency_label_financial_snapshot"(account_row."id")
    INTO account_before, financial_before
    FROM "billing_accounts" account_row
    WHERE account_row."id" = manifest_row.billing_account_id
    FOR UPDATE;

    INSERT INTO "billing_account_currency_label_repair_items" (
      "id", "run_id", "billing_account_id", "ordinal",
      "before_currency", "after_currency", "before_account_snapshot",
      "before_account_snapshot_hash", "after_account_snapshot",
      "after_account_snapshot_hash", "financial_snapshot",
      "financial_snapshot_hash", "created_at"
    ) VALUES (
      gen_random_uuid()::TEXT, operation_run_id,
      manifest_row.billing_account_id, manifest_row.ordinal,
      source_currency, target_currency, account_before,
      encode(sha256(convert_to(account_before::TEXT, 'UTF8')), 'hex'),
      jsonb_set(account_before, '{currency}', to_jsonb(target_currency)),
      encode(sha256(convert_to(jsonb_set(
        account_before, '{currency}', to_jsonb(target_currency)
      )::TEXT, 'UTF8')), 'hex'),
      financial_before,
      encode(sha256(convert_to(financial_before::TEXT, 'UTF8')), 'hex'),
      operation_at
    );

    UPDATE "billing_accounts"
    SET "currency" = target_currency
    WHERE "id" = manifest_row.billing_account_id
      AND "currency" = source_currency;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'currency label repair account compare-and-swap failed account=%',
        manifest_row.billing_account_id USING ERRCODE = '40001';
    END IF;

    SELECT to_jsonb(account_row),
      "billing_account_currency_label_financial_snapshot"(account_row."id")
    INTO account_after, financial_after
    FROM "billing_accounts" account_row
    WHERE account_row."id" = manifest_row.billing_account_id;
    IF account_after IS DISTINCT FROM jsonb_set(
        account_before, '{currency}', to_jsonb(target_currency)
      )
      OR financial_after IS DISTINCT FROM financial_before
    THEN
      RAISE EXCEPTION 'currency label repair changed non-label evidence account=%',
        manifest_row.billing_account_id USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR eligible_event_row IN
    SELECT expected.*
    FROM "billing_account_currency_label_event_v1"() expected
    ORDER BY expected.ordinal
  LOOP
    SELECT jsonb_build_object(
      'event', to_jsonb(event_row)
        - 'raw_event'
        - 'billing_result'
        - 'subject_snapshot'
        - 'pricing_snapshot',
      'evidence', to_jsonb(evidence_row) - 'raw_evidence',
      'resolvedBillingAccountId', tenant_row."billing_account_id"
    )
    INTO eligible_event_snapshot
    FROM "gateway_billing_events" event_row
    JOIN "gateway_usage_evidences" evidence_row
      ON evidence_row."id" = eligible_event_row.evidence_id
      AND evidence_row."gateway_billing_event_id" = event_row."id"
    JOIN "api_keys" api_key_row
      ON api_key_row."id" = event_row."api_key_id"
    JOIN "tenants" tenant_row
      ON tenant_row."id" = api_key_row."tenant_id"
    WHERE event_row."id" = eligible_event_row.gateway_billing_event_id
      AND event_row."request_id" = eligible_event_row.request_id
      AND event_row."evidence_hash" = eligible_event_row.evidence_hash
      AND tenant_row."billing_account_id"
        = eligible_event_row.billing_account_id;
    IF eligible_event_snapshot IS NULL THEN
      RAISE EXCEPTION 'currency label repair event changed before audit event=%',
        eligible_event_row.gateway_billing_event_id
        USING ERRCODE = '40001';
    END IF;
    eligible_event_row_hash := encode(sha256(convert_to(
      jsonb_build_object(
        'runId', operation_run_id,
        'billingAccountId', eligible_event_row.billing_account_id,
        'gatewayBillingEventId',
          eligible_event_row.gateway_billing_event_id,
        'requestId', eligible_event_row.request_id,
        'evidenceId', eligible_event_row.evidence_id,
        'evidenceHash', eligible_event_row.evidence_hash,
        'failureCode', 'BILLING_CURRENCY_MIGRATION_REQUIRED',
        'failureReason', 'settlement_anchor_missing',
        'errorMessage',
          'Gateway billing currency mismatch: account=USD deployment=CNY',
        'errorFingerprint',
          'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
        'eventSnapshot', eligible_event_snapshot
      )::TEXT, 'UTF8'
    )), 'hex');

    INSERT INTO "billing_account_currency_label_repair_eligible_events" (
      "id", "run_id", "item_id", "gateway_billing_event_id",
      "request_id", "evidence_id", "evidence_hash", "failure_code",
      "failure_reason", "error_message", "error_fingerprint",
      "event_snapshot", "row_hash", "created_at"
    ) SELECT
      gen_random_uuid()::TEXT, operation_run_id, item."id",
      eligible_event_row.gateway_billing_event_id,
      eligible_event_row.request_id, eligible_event_row.evidence_id,
      eligible_event_row.evidence_hash,
      'BILLING_CURRENCY_MIGRATION_REQUIRED',
      'settlement_anchor_missing',
      'Gateway billing currency mismatch: account=USD deployment=CNY',
      'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
      eligible_event_snapshot, eligible_event_row_hash, operation_at
    FROM "billing_account_currency_label_repair_items" item
    WHERE item."run_id" = operation_run_id
      AND item."billing_account_id"
        = eligible_event_row.billing_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'currency label repair event has no account item event=%',
        eligible_event_row.gateway_billing_event_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  PERFORM set_config(
    'billing.currency_label_repair_run_id',
    COALESCE(previous_transition_marker, ''), TRUE
  );

  IF (SELECT COUNT(*)
      FROM "billing_account_currency_label_repair_items"
      WHERE "run_id" = operation_run_id) <> expected_account_count
    OR (SELECT COUNT(*)
        FROM "billing_account_currency_label_repair_eligible_events"
        WHERE "run_id" = operation_run_id) <> 3
    OR EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_repair_items" item
      JOIN "billing_accounts" account_row
        ON account_row."id" = item."billing_account_id"
      WHERE item."run_id" = operation_run_id
        AND (
          account_row."currency" IS DISTINCT FROM target_currency
          OR to_jsonb(account_row) IS DISTINCT FROM item."after_account_snapshot"
          OR encode(sha256(convert_to(
            "billing_account_currency_label_financial_snapshot"(
              account_row."id"
            )::TEXT, 'UTF8'
          )), 'hex') IS DISTINCT FROM item."financial_snapshot_hash"
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "billing_account_currency_label_repair_eligible_events" eligible
      JOIN "billing_account_currency_label_repair_items" item
        ON item."id" = eligible."item_id"
      JOIN "gateway_billing_events" event_row
        ON event_row."id" = eligible."gateway_billing_event_id"
      JOIN "gateway_usage_evidences" evidence_row
        ON evidence_row."id" = eligible."evidence_id"
      JOIN "api_keys" api_key_row
        ON api_key_row."id" = event_row."api_key_id"
      JOIN "tenants" tenant_row
        ON tenant_row."id" = api_key_row."tenant_id"
      WHERE eligible."run_id" = operation_run_id
        AND (
          item."run_id" IS DISTINCT FROM operation_run_id
          OR item."billing_account_id"
            IS DISTINCT FROM tenant_row."billing_account_id"
          OR event_row."request_id" IS DISTINCT FROM eligible."request_id"
          OR evidence_row."gateway_billing_event_id"
            IS DISTINCT FROM event_row."id"
          OR event_row."evidence_hash"
            IS DISTINCT FROM eligible."evidence_hash"
          OR evidence_row."evidence_hash"
            IS DISTINCT FROM eligible."evidence_hash"
          OR encode(sha256(convert_to(
            jsonb_build_object(
              'runId', eligible."run_id",
              'billingAccountId', item."billing_account_id",
              'gatewayBillingEventId', eligible."gateway_billing_event_id",
              'requestId', eligible."request_id",
              'evidenceId', eligible."evidence_id",
              'evidenceHash', eligible."evidence_hash",
              'failureCode', eligible."failure_code",
              'failureReason', eligible."failure_reason",
              'errorMessage', eligible."error_message",
              'errorFingerprint', eligible."error_fingerprint",
              'eventSnapshot', eligible."event_snapshot"
            )::TEXT, 'UTF8'
          )), 'hex') IS DISTINCT FROM eligible."row_hash"
        )
    )
  THEN
    RAISE EXCEPTION 'currency label repair terminal proof failed'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY SELECT operation_run_id, target_manifest_version, 'APPLIED'::TEXT,
    expected_account_count, operation_at;
END
$$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "billing_account_currency_label_repair_runs" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "billing_account_currency_label_repair_items" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE "billing_account_currency_label_repair_eligible_events"
  FROM PUBLIC;
-- Billing's runtime terminal proof must remain readable when migrations and
-- application queries use distinct roles.  Only SELECT is shared; all writes
-- remain owner-only and the append-only triggers protect owner mistakes.
GRANT SELECT ON TABLE "billing_account_currency_label_repair_runs" TO PUBLIC;
GRANT SELECT ON TABLE "billing_account_currency_label_repair_items" TO PUBLIC;
GRANT SELECT ON TABLE
  "billing_account_currency_label_repair_eligible_events" TO PUBLIC;
REVOKE ALL ON FUNCTION
  "apply_legacy_billing_account_currency_label_repair_v1"(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP(3)
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_manifest_v1"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_pending_order_v1"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_event_v1"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_failed_usd_order_v1"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "billing_account_currency_label_evidence_v1"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "billing_account_currency_label_financial_snapshot"(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  "reject_billing_account_currency_label_repair_audit_mutation"()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION "enforce_billing_account_currency_immutability"()
  FROM PUBLIC;

COMMENT ON FUNCTION
  "apply_legacy_billing_account_currency_label_repair_v1"(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMP(3)
  ) IS
  'Drained, database-bound, maker/checker correction of the fixed Shanghai UAT legacy USD label manifest. It changes no monetary value.';
