-- Provider-order creation is an external side effect. Persist a dedicated
-- attempt token and lease before invoking it so concurrent payment/admin
-- retries cannot both own the same entitlement, and a stale response cannot
-- overwrite credentials written by a newer attempt.
ALTER TABLE "coding_plan_provider_entitlements"
    ADD COLUMN "fulfillment_attempt_id" TEXT,
    ADD COLUMN "fulfillment_claimed_at" TIMESTAMP(3);
