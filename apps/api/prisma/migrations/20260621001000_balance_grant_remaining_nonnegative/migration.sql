ALTER TABLE "balance_grants"
  ADD CONSTRAINT "balance_grants_remaining_amount_usd_nonnegative"
  CHECK ("remaining_amount_usd" >= 0) NOT VALID;
