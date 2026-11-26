CREATE TYPE "RefundCompensationTaskStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'MANUAL_REVIEW'
);

CREATE TYPE "RefundCompensationTaskAction" AS ENUM (
  'REFUND_BALANCE',
  'CREDIT_DEDUCT',
  'CANCEL_SUBSCRIPTION',
  'CANCEL_CODING_PLAN_ENTITLEMENT',
  'SYNC_PUBLISHER_KEYS',
  'INVALIDATE_SUBSCRIPTION_CACHE',
  'NOTIFY_CREDIT_CHANGED',
  'MARK_ORDER_ITEM_TERMINAL'
);

CREATE TABLE "refund_compensation_tasks" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "order_item_id" TEXT,
  "task_key" TEXT NOT NULL,
  "action" "RefundCompensationTaskAction" NOT NULL,
  "status" "RefundCompensationTaskStatus" NOT NULL DEFAULT 'PENDING',
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "product_id" TEXT,
  "plan_id" TEXT,
  "amount_cents" INTEGER,
  "credits_amount" INTEGER,
  "payload" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 12,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" TEXT,
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refund_compensation_tasks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refund_compensation_tasks_task_key_key"
  ON "refund_compensation_tasks"("task_key");

CREATE INDEX "refund_compensation_tasks_order_id_status_next_run_at_idx"
  ON "refund_compensation_tasks"("order_id", "status", "next_run_at");

CREATE INDEX "refund_compensation_tasks_status_next_run_at_idx"
  ON "refund_compensation_tasks"("status", "next_run_at");

CREATE INDEX "refund_compensation_tasks_order_item_id_idx"
  ON "refund_compensation_tasks"("order_item_id");

ALTER TABLE "refund_compensation_tasks"
  ADD CONSTRAINT "refund_compensation_tasks_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
