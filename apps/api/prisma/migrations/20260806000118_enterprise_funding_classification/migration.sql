-- Freeze the funding composition of each consumption allocation. Historical
-- rows deliberately remain unclassified; only new online writes set
-- funding_classification_complete=true.
ALTER TABLE "balance_consumption_allocations"
  ADD COLUMN "approved_credit_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "unapproved_debt_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "funding_classification_complete" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "balance_consumption_allocations"
  ADD CONSTRAINT "balance_allocations_funding_amounts_check"
    CHECK (
      "approved_credit_usd" >= 0
      AND "unapproved_debt_usd" >= 0
      AND "approved_credit_usd" + "unapproved_debt_usd" <= "amount_usd"
    ),
  ADD CONSTRAINT "balance_allocations_complete_funding_shape_check"
    CHECK (
      NOT "funding_classification_complete"
      OR CASE
        WHEN "source" = 'ENTERPRISE_CREDIT' THEN
          "approved_credit_usd" + "unapproved_debt_usd" = "amount_usd"
          AND NOT (
            "approved_credit_usd" > 0
            AND "unapproved_debt_usd" > 0
          )
        WHEN "source" = 'NEGATIVE_BALANCE' THEN
          "approved_credit_usd" = 0
          AND "unapproved_debt_usd" = "amount_usd"
        ELSE
          "approved_credit_usd" = 0
          AND "unapproved_debt_usd" = 0
      END
    ),
  ADD CONSTRAINT "balance_allocations_credit_terms_scope_check"
    CHECK (
      NOT "funding_classification_complete"
      OR "approved_credit_usd" > 0
      OR (
        "credit_terms_days" IS NULL
        AND "credit_due_at" IS NULL
      )
    );

CREATE INDEX "balance_allocations_account_funding_open_idx"
  ON "balance_consumption_allocations"(
    "billing_account_id",
    "funding_classification_complete",
    "settled_at",
    "created_at"
  )
  WHERE "approved_credit_usd" > 0 OR "unapproved_debt_usd" > 0;
