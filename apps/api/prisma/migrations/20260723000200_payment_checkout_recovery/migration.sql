CREATE TYPE "PaymentCheckoutInitState" AS ENUM (
  'NOT_STARTED',
  'INITIALIZING',
  'OUTCOME_UNKNOWN',
  'READY',
  'TERMINAL'
);

ALTER TABLE "orders"
  ADD COLUMN "partner_idempotency_key" TEXT,
  ADD COLUMN "checkout_init_state" "PaymentCheckoutInitState" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "checkout_lease_id" TEXT,
  ADD COLUMN "checkout_lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "checkout_context_encrypted" TEXT,
  ADD COLUMN "checkout_provider_reference" TEXT,
  ADD COLUMN "checkout_pay_url_encrypted" TEXT,
  ADD COLUMN "checkout_pay_url_expires_at" TIMESTAMP(3),
  ADD COLUMN "provider_subscription_ended_at" TIMESTAMP(3);

CREATE INDEX "orders_checkout_init_state_checkout_lease_expires_at_idx"
  ON "orders"("checkout_init_state", "checkout_lease_expires_at");

-- Keep the raw caller key in orders.idempotency_key for old-binary rollback
-- compatibility. The new product-wide namespace gets its own uniqueness key.
-- Existing rows are NULL, so uniqueness cannot fail on historical data.
-- Prisma executes this migration in a transaction, so PostgreSQL does not
-- permit CONCURRENTLY here; deploy it in the documented maintenance window.
CREATE UNIQUE INDEX "orders_partner_idempotency_key_key"
  ON "orders"("partner_idempotency_key");

-- Stripe renewal delivery is at-least-once. Anchor each logical invoice/item
-- activation to a stable key so a StripeEvent marker write failure or partial
-- bundle retry cannot replace the subscription period or issue quota twice.
ALTER TABLE "subscription_periods"
  ADD COLUMN "activation_idempotency_key" TEXT;

CREATE UNIQUE INDEX "subscription_periods_activation_idempotency_key_key"
  ON "subscription_periods"("activation_idempotency_key");

-- A Stripe subscription refund and the provider-side subscription cancellation
-- are two separate remote effects. Persist the latter so a timeout, non-canceled
-- response, or process crash cannot let a locally-refunded order keep renewing.
CREATE TABLE "stripe_subscription_cancellation_tasks" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "refund_id" TEXT,
  "refunded_invoice_id" TEXT NOT NULL,
  "refunded_activation_idempotency_key" TEXT NOT NULL,
  "refunded_subscription_period_id" TEXT,
  "original_grant_idempotency_key" TEXT,
  "skip_entitlement_compensation" BOOLEAN NOT NULL DEFAULT false,
  "payment_provider_instance_id" TEXT,
  "status" "RefundCompensationTaskStatus" NOT NULL DEFAULT 'PENDING',
  "provider_canceled_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 12,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stripe_subscription_cancellation_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stripe_subscription_cancellation_tasks_order_id_key"
  ON "stripe_subscription_cancellation_tasks"("order_id");

CREATE INDEX "stripe_subscription_cancellation_tasks_status_next_run_at_idx"
  ON "stripe_subscription_cancellation_tasks"("status", "next_run_at");

CREATE INDEX "stripe_subscription_cancellation_tasks_status_locked_at_idx"
  ON "stripe_subscription_cancellation_tasks"("status", "locked_at");

ALTER TABLE "stripe_subscription_cancellation_tasks"
  ADD CONSTRAINT "stripe_sub_cancel_identity_nonempty_check"
    CHECK (
      BTRIM("subscription_id") <> ''
      AND BTRIM("refunded_invoice_id") <> ''
      AND BTRIM("refunded_activation_idempotency_key") <> ''
    ),
  ADD CONSTRAINT "stripe_sub_cancel_attempts_nonnegative_check"
    CHECK ("attempts" >= 0),
  ADD CONSTRAINT "stripe_sub_cancel_max_attempts_positive_check"
    CHECK ("max_attempts" > 0),
  ADD CONSTRAINT "stripe_sub_cancel_lock_state_check"
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

ALTER TABLE "stripe_subscription_cancellation_tasks"
  ADD CONSTRAINT "stripe_subscription_cancellation_tasks_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
