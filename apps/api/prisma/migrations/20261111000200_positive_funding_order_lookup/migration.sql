-- The proof reads positive funding by account, order and (for legacy grants) amount.
CREATE INDEX CONCURRENTLY balance_transactions_positive_funding_order_idx
  ON public.balance_transactions (billing_account_id, order_id, amount_usd)
  WHERE amount_usd > 0;
