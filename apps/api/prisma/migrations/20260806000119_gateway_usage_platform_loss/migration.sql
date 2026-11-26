-- Immutable finance closure for corrected evidence received after a request
-- already reached a funding terminal state. No customer balance mutation is
-- represented here: customer_deduction_usd is structurally fixed at zero.
CREATE TABLE "gateway_usage_platform_losses" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "reconciliation_action_id" TEXT NOT NULL,
  "correction_evidence_id" TEXT NOT NULL,
  "correction_evidence_hash" TEXT NOT NULL,
  "original_settlement_receipt_id" TEXT NOT NULL,
  "absorption_settlement_receipt_id" TEXT NOT NULL,
  "billing_unit" TEXT NOT NULL,
  "customer_charge_before_usd" DECIMAL(20,12) NOT NULL,
  "customer_charge_corrected_usd" DECIMAL(20,12) NOT NULL,
  "absorbed_customer_charge_usd" DECIMAL(20,12) NOT NULL,
  "customer_deduction_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  "provider_cost_before_usd" DECIMAL(20,12) NOT NULL,
  "provider_cost_corrected_usd" DECIMAL(20,12) NOT NULL,
  "provider_cost_delta_usd" DECIMAL(20,12) NOT NULL,
  "platform_loss_usd" DECIMAL(20,12) NOT NULL,
  "valuation_policy_version" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gateway_usage_platform_losses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_platform_losses_financial_values_check" CHECK (
    "billing_unit" IN ('BALANCE', 'CREDITS')
    AND "customer_charge_before_usd" >= 0
    AND "customer_charge_corrected_usd" > "customer_charge_before_usd"
    AND "absorbed_customer_charge_usd" =
      "customer_charge_corrected_usd" - "customer_charge_before_usd"
    AND "customer_deduction_usd" = 0
    AND "provider_cost_before_usd" >= 0
    AND "provider_cost_corrected_usd" >= 0
    AND "provider_cost_delta_usd" =
      "provider_cost_corrected_usd" - "provider_cost_before_usd"
    AND "platform_loss_usd" = "absorbed_customer_charge_usd"
  ),
  CONSTRAINT "gateway_usage_platform_losses_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gateway_usage_platform_losses_action_fkey"
    FOREIGN KEY ("reconciliation_action_id") REFERENCES "gateway_usage_reconciliation_actions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gateway_usage_platform_losses_evidence_fkey"
    FOREIGN KEY ("correction_evidence_id") REFERENCES "gateway_usage_evidences"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gateway_usage_platform_losses_original_receipt_fkey"
    FOREIGN KEY ("original_settlement_receipt_id") REFERENCES "gateway_usage_settlement_receipts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gateway_usage_platform_losses_absorption_receipt_fkey"
    FOREIGN KEY ("absorption_settlement_receipt_id") REFERENCES "gateway_usage_settlement_receipts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "gateway_usage_platform_losses_action_key"
  ON "gateway_usage_platform_losses"("reconciliation_action_id");
CREATE UNIQUE INDEX "gateway_usage_platform_losses_absorption_receipt_key"
  ON "gateway_usage_platform_losses"("absorption_settlement_receipt_id");
CREATE UNIQUE INDEX "gateway_usage_platform_losses_idempotency_key_key"
  ON "gateway_usage_platform_losses"("idempotency_key");
CREATE INDEX "gateway_usage_platform_losses_request_created_idx"
  ON "gateway_usage_platform_losses"("request_id", "created_at");
CREATE INDEX "gateway_usage_platform_losses_event_created_idx"
  ON "gateway_usage_platform_losses"("gateway_billing_event_id", "created_at");
CREATE INDEX "gateway_usage_platform_losses_evidence_idx"
  ON "gateway_usage_platform_losses"("correction_evidence_id");

CREATE TRIGGER gateway_usage_platform_losses_append_only
  BEFORE UPDATE OR DELETE ON "gateway_usage_platform_losses"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();
