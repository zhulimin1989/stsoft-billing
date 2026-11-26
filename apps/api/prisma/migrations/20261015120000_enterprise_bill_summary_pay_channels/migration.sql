SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enterprise_bill_month_summaries'
      AND column_name = 'account_pay_cents'
  ) THEN
    ALTER TABLE "enterprise_bill_month_summaries"
      ADD COLUMN "account_pay_cents" BIGINT NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'enterprise_bill_month_summaries'
      AND column_name = 'credit_pay_cents'
  ) THEN
    ALTER TABLE "enterprise_bill_month_summaries"
      ADD COLUMN "credit_pay_cents" BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;
