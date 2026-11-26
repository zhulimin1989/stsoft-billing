ALTER TABLE "product_runtime_policies"
  ADD COLUMN "protocol_strategy" TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN "allow_high_loss_bridge_when_no_native" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "allow_bridge_on_native_failure" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "high_loss_bridge_reason" TEXT,
  ADD COLUMN "high_loss_bridge_owner" TEXT,
  ADD COLUMN "high_loss_bridge_expires_at" TIMESTAMP(3),
  ADD COLUMN "high_loss_bridge_approval" TEXT;

