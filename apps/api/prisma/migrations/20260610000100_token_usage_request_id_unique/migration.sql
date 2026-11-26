-- Persist gateway request_id on token_usage so usage detail, ledger, and
-- gateway_billing_events can be reconciled by the same idempotency key.

ALTER TABLE "token_usage"
  ADD COLUMN IF NOT EXISTS "request_id" TEXT;

-- Best-effort backfill for rows produced after gateway_billing_events was
-- introduced. Older rows may remain NULL and should be reconciled manually if
-- business reporting needs them.
UPDATE "token_usage" tu
SET "request_id" = gbe."request_id"
FROM "gateway_billing_events" gbe
WHERE tu."request_id" IS NULL
  AND gbe."billing_result"->>'tokenUsageId' = tu."id";

CREATE UNIQUE INDEX IF NOT EXISTS "token_usage_request_id_key"
  ON "token_usage"("request_id");
