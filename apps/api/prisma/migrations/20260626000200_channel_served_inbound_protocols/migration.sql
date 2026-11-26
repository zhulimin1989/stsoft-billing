ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "served_inbound_protocols" TEXT;
