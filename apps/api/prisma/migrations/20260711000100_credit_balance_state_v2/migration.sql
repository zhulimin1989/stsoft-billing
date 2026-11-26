CREATE TYPE "CreditBalanceOutboxStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'MANUAL_REVIEW'
);

ALTER TABLE "credit_transactions"
  ADD COLUMN "balance_version" BIGINT;

CREATE TABLE "credit_balance_states" (
  "subscription_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "quota" INTEGER NOT NULL DEFAULT 0,
  "bonus" INTEGER NOT NULL DEFAULT 0,
  "version" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_balance_states_pkey" PRIMARY KEY ("subscription_id"),
  CONSTRAINT "credit_balance_states_nonnegative"
    CHECK ("quota" >= 0 AND "bonus" >= 0 AND "version" >= 0)
);

CREATE TABLE "credit_balance_outbox" (
  "id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "version" BIGINT NOT NULL,
  "quota" INTEGER NOT NULL,
  "bonus" INTEGER NOT NULL,
  "status" "CreditBalanceOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 12,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "last_error" TEXT,
  "processed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "credit_balance_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_balance_outbox_snapshot_nonnegative"
    CHECK (
      "quota" >= 0
      AND "bonus" >= 0
      AND "version" >= 0
      AND "attempts" >= 0
      AND "max_attempts" > 0
    )
);

CREATE INDEX "credit_balance_states_user_id_idx"
  ON "credit_balance_states"("user_id");

CREATE UNIQUE INDEX "credit_balance_outbox_subscription_id_version_key"
  ON "credit_balance_outbox"("subscription_id", "version");

CREATE INDEX "credit_balance_outbox_status_next_run_at_idx"
  ON "credit_balance_outbox"("status", "next_run_at");

CREATE INDEX "credit_balance_outbox_status_locked_at_idx"
  ON "credit_balance_outbox"("status", "locked_at");

ALTER TABLE "credit_balance_states"
  ADD CONSTRAINT "credit_balance_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "credit_balance_outbox"
  ADD CONSTRAINT "credit_balance_outbox_subscription_id_fkey"
  FOREIGN KEY ("subscription_id")
  REFERENCES "credit_balance_states"("subscription_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
