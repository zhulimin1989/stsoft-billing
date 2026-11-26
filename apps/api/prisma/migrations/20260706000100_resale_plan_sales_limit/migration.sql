ALTER TABLE "plans"
  ADD COLUMN IF NOT EXISTS "sales_limit" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "orders_plan_id_order_type_status_idx"
  ON "orders"("plan_id", "order_type", "status");
