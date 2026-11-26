-- Record whether a restriction projection intent actually published a fanout.
--
-- The `pending_usage_unreserved` funding guard is created and released inside
-- one request (measured p50 19ms / p99 41ms in production). The database
-- trigger enqueues one intent per status transition, so every guarded request
-- costs two account-wide key-balance fanouts -- and by the time the 15s worker
-- claims either intent the guard is already released, so both republish the
-- exact same has_balance for every Key on the account.
--
-- Skipping those fanouts requires knowing whether the paired ACTIVE intent
-- published the restricted state: only then does the RELEASED intent have
-- something to restore. Deriving that from completed_at vs released_at is
-- possible but not auditable, so the decision is recorded explicitly.
--
-- NULL means "decided before this column existed" and is deliberately treated
-- as "did publish" by the worker, so historical rows keep the fail-safe
-- behaviour of always restoring.
ALTER TABLE "billing_restriction_projection_intents"
  ADD COLUMN "projected" BOOLEAN;

COMMENT ON COLUMN "billing_restriction_projection_intents"."projected" IS
  'TRUE when this intent published a Gateway fanout; FALSE when it was a no-op because the restriction transition never changed the admission projection; NULL for rows completed before this column existed.';
