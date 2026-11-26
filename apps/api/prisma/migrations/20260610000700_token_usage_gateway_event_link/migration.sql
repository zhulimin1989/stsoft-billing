-- Link settled token usage rows back to the gateway settlement event that admitted them.
ALTER TABLE "token_usage"
  ADD COLUMN "gateway_billing_event_id" TEXT;

UPDATE "token_usage" tu
SET "gateway_billing_event_id" = gbe."id"
FROM "gateway_billing_events" gbe
WHERE tu."gateway_billing_event_id" IS NULL
  AND tu."request_id" IS NOT NULL
  AND tu."request_id" = gbe."request_id";

CREATE UNIQUE INDEX "token_usage_gateway_billing_event_id_key"
  ON "token_usage"("gateway_billing_event_id");

ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_gateway_billing_event_id_fkey"
  FOREIGN KEY ("gateway_billing_event_id")
  REFERENCES "gateway_billing_events"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
