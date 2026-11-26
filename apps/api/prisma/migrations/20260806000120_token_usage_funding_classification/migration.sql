-- Preserve gross customer charge independently from cash/prepaid collection,
-- approved enterprise receivable and unapproved debt. Historical rows remain
-- explicitly unclassified; all new writes set the completeness marker.
ALTER TABLE "token_usage"
  ADD COLUMN "customer_collected_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "customer_approved_receivable_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "customer_unapproved_debt_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "customer_funding_classification_complete" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_customer_funding_classification_check" CHECK (
    "customer_charge_usd" >= 0
    AND "customer_collected_usd" >= 0
    AND "customer_approved_receivable_usd" >= 0
    AND "customer_unapproved_debt_usd" >= 0
    AND (
      NOT "customer_funding_classification_complete"
      OR "customer_collected_usd"
        + "customer_approved_receivable_usd"
        + "customer_unapproved_debt_usd" = "customer_charge_usd"
    )
  ) NOT VALID;
ALTER TABLE "token_usage"
  VALIDATE CONSTRAINT "token_usage_customer_funding_classification_check";

CREATE INDEX "token_usage_funding_classification_created_idx"
  ON "token_usage"("customer_funding_classification_complete", "created_at");

ALTER TABLE "gateway_usage_settlement_receipts"
  DROP CONSTRAINT "gateway_usage_receipts_funding_outcome_check";
ALTER TABLE "gateway_usage_settlement_receipts"
  ADD CONSTRAINT "gateway_usage_receipts_funding_outcome_check"
    CHECK ("funding_outcome" IN (
      'COLLECTED', 'RECEIVABLE', 'INCLUDED', 'DEBT_OPEN', 'ABSORBED'
    )) NOT VALID;
ALTER TABLE "gateway_usage_settlement_receipts"
  VALIDATE CONSTRAINT "gateway_usage_receipts_funding_outcome_check";
