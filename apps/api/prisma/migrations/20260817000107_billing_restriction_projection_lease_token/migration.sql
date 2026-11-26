-- Keep long-running required admission fanout owned by exactly one Billing
-- worker. The token is independent from locked_at so heartbeats can extend the
-- lease without weakening completion/failure fencing.
ALTER TABLE "billing_restriction_projection_intents"
  ADD COLUMN "lease_id" TEXT;

COMMENT ON COLUMN "billing_restriction_projection_intents"."lease_id" IS
  'Opaque owner token for PROCESSING lease heartbeats and terminal CAS writes';
