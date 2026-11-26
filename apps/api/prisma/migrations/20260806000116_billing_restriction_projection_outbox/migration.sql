-- Every Billing restriction transition must be projected to Gateway even when
-- the API process crashes immediately after committing the local transaction.
CREATE TABLE "billing_restriction_projection_intents" (
  "id" TEXT NOT NULL,
  "billing_access_restriction_id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT,
  "api_key_id" TEXT,
  "billing_account_id" TEXT,
  "restriction_status" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_restriction_projection_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_restriction_projection_intents_restriction_fkey"
    FOREIGN KEY ("billing_access_restriction_id")
    REFERENCES "billing_access_restrictions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "billing_restriction_projection_intents_target_check"
    CHECK (
      "billing_account_id" IS NOT NULL
      OR "api_key_id" IS NOT NULL
      OR "gateway_billing_event_id" IS NOT NULL
    ),
  CONSTRAINT "billing_restriction_projection_intents_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'FAILED', 'SUCCEEDED')),
  CONSTRAINT "billing_restriction_projection_intents_attempts_check"
    CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "billing_restriction_projection_restriction_status_key"
  ON "billing_restriction_projection_intents"(
    "billing_access_restriction_id",
    "restriction_status"
  );
CREATE INDEX "billing_restriction_projection_intents_due_idx"
  ON "billing_restriction_projection_intents"("status", "next_run_at");
CREATE INDEX "billing_restriction_projection_intents_account_status_idx"
  ON "billing_restriction_projection_intents"("billing_account_id", "status");
CREATE INDEX "billing_restriction_projection_intents_key_status_idx"
  ON "billing_restriction_projection_intents"("api_key_id", "status");

CREATE OR REPLACE FUNCTION enqueue_billing_restriction_projection_intent()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;

  INSERT INTO "billing_restriction_projection_intents" (
    "id",
    "billing_access_restriction_id",
    "gateway_billing_event_id",
    "api_key_id",
    "billing_account_id",
    "restriction_status",
    "status",
    "attempts",
    "next_run_at",
    "created_at",
    "updated_at"
  ) VALUES (
    gen_random_uuid()::TEXT,
    NEW."id",
    NEW."gateway_billing_event_id",
    NEW."api_key_id",
    NEW."billing_account_id",
    NEW."status",
    'PENDING',
    0,
    clock_timestamp(),
    clock_timestamp(),
    clock_timestamp()
  )
  ON CONFLICT ("billing_access_restriction_id", "restriction_status") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_access_restrictions_projection_intent
  AFTER INSERT OR UPDATE OF "status" ON "billing_access_restrictions"
  FOR EACH ROW EXECUTE FUNCTION enqueue_billing_restriction_projection_intent();

ALTER TABLE "billing_access_restrictions"
  ADD CONSTRAINT "billing_access_restrictions_status_check"
    CHECK ("status" IN ('ACTIVE', 'RELEASED')) NOT VALID;
ALTER TABLE "billing_access_restrictions"
  VALIDATE CONSTRAINT "billing_access_restrictions_status_check";

CREATE OR REPLACE FUNCTION enforce_billing_access_restriction_lifecycle()
RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" = 'RELEASED') THEN
    RAISE EXCEPTION 'billing_access_restrictions only allows ACTIVE -> RELEASED; create a new row to reactivate'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_access_restrictions_lifecycle_guard
  BEFORE UPDATE OF "status" ON "billing_access_restrictions"
  FOR EACH ROW EXECUTE FUNCTION enforce_billing_access_restriction_lifecycle();

-- Existing active/released rows may predate the outbox. Recompute their current
-- projection once after deploy; duplicate targets are harmless and idempotent.
INSERT INTO "billing_restriction_projection_intents" (
  "id",
  "billing_access_restriction_id",
  "gateway_billing_event_id",
  "api_key_id",
  "billing_account_id",
  "restriction_status",
  "status",
  "attempts",
  "next_run_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::TEXT,
  restriction."id",
  restriction."gateway_billing_event_id",
  restriction."api_key_id",
  restriction."billing_account_id",
  restriction."status",
  'PENDING',
  0,
  clock_timestamp(),
  clock_timestamp(),
  clock_timestamp()
FROM "billing_access_restrictions" restriction
WHERE restriction."billing_account_id" IS NOT NULL
   OR restriction."api_key_id" IS NOT NULL
   OR restriction."gateway_billing_event_id" IS NOT NULL
ON CONFLICT ("billing_access_restriction_id", "restriction_status") DO NOTHING;
