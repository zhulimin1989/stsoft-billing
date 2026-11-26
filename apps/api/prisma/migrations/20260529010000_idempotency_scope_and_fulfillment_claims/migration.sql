ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_pkey";
ALTER TABLE "idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key", "scope");

ALTER TABLE "orders" ADD COLUMN "fulfillment_attempt_id" TEXT;
ALTER TABLE "orders" ADD COLUMN "fulfillment_claimed_at" TIMESTAMP(3);

CREATE INDEX "orders_status_fulfillment_claimed_at_idx"
    ON "orders"("status", "fulfillment_claimed_at");
CREATE INDEX "orders_fulfillment_attempt_id_idx"
    ON "orders"("fulfillment_attempt_id");
