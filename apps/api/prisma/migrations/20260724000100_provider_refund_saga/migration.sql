CREATE TYPE "ProviderRefundIntentStatus" AS ENUM (
  'PREPARED',
  'RUNNING',
  'PENDING_PROVIDER',
  'PROVIDER_SUCCEEDED',
  'PROVIDER_FAILED',
  'COMPLETED',
  'MANUAL_REVIEW'
);

CREATE TABLE "provider_refund_intents" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "channel" "PayChannel" NOT NULL,
  "trade_no" TEXT NOT NULL,
  "request_no" TEXT NOT NULL,
  "provider_refund_id" TEXT,
  "amount_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "payment_provider_instance_id" TEXT,
  "skip_entitlement_compensation" BOOLEAN NOT NULL DEFAULT false,
  "skip_recharge_balance_compensation" BOOLEAN NOT NULL DEFAULT false,
  "preflight_completed_at" TIMESTAMP(3) NOT NULL,
  "status" "ProviderRefundIntentStatus" NOT NULL DEFAULT 'PREPARED',
  "provider_status" TEXT,
  "provider_attempted_at" TIMESTAMP(3),
  "provider_confirmed_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 12,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "provider_refund_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_refund_intents_order_id_key"
  ON "provider_refund_intents"("order_id");

CREATE UNIQUE INDEX "provider_refund_intents_request_no_key"
  ON "provider_refund_intents"("request_no");

CREATE INDEX "provider_refund_intents_status_next_run_at_idx"
  ON "provider_refund_intents"("status", "next_run_at");

CREATE INDEX "provider_refund_intents_status_locked_at_idx"
  ON "provider_refund_intents"("status", "locked_at");

CREATE INDEX "provider_refund_intents_channel_provider_status_idx"
  ON "provider_refund_intents"("channel", "provider_status");

ALTER TABLE "provider_refund_intents"
  ADD CONSTRAINT "provider_refund_intents_provider_channel_check"
    CHECK ("channel" IN ('WECHAT', 'ALIPAY', 'STRIPE')),
  ADD CONSTRAINT "provider_refund_intents_amount_positive_check"
    CHECK ("amount_cents" > 0),
  ADD CONSTRAINT "provider_refund_intents_identity_nonempty_check"
    CHECK (
      BTRIM("trade_no") <> ''
      AND BTRIM("request_no") <> ''
      AND BTRIM("currency") <> ''
      AND BTRIM("reason") <> ''
    ),
  ADD CONSTRAINT "provider_refund_intents_attempts_nonnegative_check"
    CHECK ("attempts" >= 0),
  ADD CONSTRAINT "provider_refund_intents_max_attempts_positive_check"
    CHECK ("max_attempts" > 0),
  ADD CONSTRAINT "provider_refund_intents_lock_state_check"
    CHECK (
      (
        "status" = 'RUNNING'
        AND "locked_at" IS NOT NULL
        AND "locked_by" IS NOT NULL
      )
      OR
      (
        "status" <> 'RUNNING'
        AND "locked_at" IS NULL
        AND "locked_by" IS NULL
      )
    );

ALTER TABLE "provider_refund_intents"
  ADD CONSTRAINT "provider_refund_intents_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
