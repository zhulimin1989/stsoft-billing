BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Enterprise balance adjustments belong to the account-level PAYG wallet,
-- while balance_transactions remains an immutable product-neutral ledger.
CREATE TYPE "BalanceTransactionAttributionSource" AS ENUM (
  'ADMIN_BALANCE_ADJUSTMENT'
);

CREATE TABLE "balance_transaction_attributions" (
  "transaction_id" TEXT NOT NULL,
  "balance_grant_id" TEXT,
  "billing_mode" "ProductBillingMode" NOT NULL,
  "source" "BalanceTransactionAttributionSource" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "balance_transaction_attributions_pkey"
    PRIMARY KEY ("transaction_id"),
  CONSTRAINT "balance_transaction_attributions_payg_admin_check"
    CHECK (
      "billing_mode" = 'PAY_AS_YOU_GO'::"ProductBillingMode"
      AND "source" = 'ADMIN_BALANCE_ADJUSTMENT'::"BalanceTransactionAttributionSource"
    )
);

CREATE UNIQUE INDEX "balance_transaction_attributions_grant_key"
  ON "balance_transaction_attributions"("balance_grant_id");

CREATE INDEX "balance_transaction_attributions_mode_source_transaction_idx"
  ON "balance_transaction_attributions"("billing_mode", "source", "transaction_id");

ALTER TABLE "balance_transaction_attributions"
  ADD CONSTRAINT "balance_transaction_attributions_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "balance_transaction_attributions_grant_fkey"
    FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "enforce_balance_transaction_attribution"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'balance transaction attributions are append-only: %', OLD."transaction_id"
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "balance_transactions" AS transaction_row
    JOIN "billing_accounts" AS account
      ON account."id" = transaction_row."billing_account_id"
    LEFT JOIN "balance_grants" AS grant_row
      ON grant_row."id" = NEW."balance_grant_id"
    WHERE transaction_row."id" = NEW."transaction_id"
      AND account."type" = 'enterprise'
      AND transaction_row."product_id" IS NULL
      AND transaction_row."order_id" IS NULL
      AND transaction_row."token_usage_id" IS NULL
      AND (
        (
          transaction_row."type" = 'ADJUST'::"TransactionType"
          AND transaction_row."amount_usd" > 0
          AND grant_row."id" IS NOT NULL
          AND grant_row."user_id" = transaction_row."user_id"
          AND grant_row."tenant_id" = transaction_row."tenant_id"
          AND grant_row."billing_account_id" = transaction_row."billing_account_id"
          AND grant_row."product_id" IS NULL
          AND grant_row."order_id" IS NULL
          AND grant_row."source" = 'VOUCHER'
          AND grant_row."granted_amount_usd" = transaction_row."amount_usd"
        )
        OR (
          transaction_row."type" = 'CONSUME'::"TransactionType"
          AND transaction_row."amount_usd" < 0
          AND NEW."balance_grant_id" IS NULL
        )
      )
  ) THEN
    RAISE EXCEPTION 'invalid enterprise balance transaction attribution: %', NEW."transaction_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_transaction_attributions_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "balance_transaction_attributions"
FOR EACH ROW
EXECUTE FUNCTION "enforce_balance_transaction_attribution"();

COMMENT ON TABLE "balance_transaction_attributions" IS
  'Append-only billing-mode attribution for product-neutral balance ledger facts.';

COMMIT;
