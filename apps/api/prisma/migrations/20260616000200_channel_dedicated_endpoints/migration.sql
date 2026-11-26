ALTER TABLE "channels"
  ADD COLUMN "owned_by" TEXT,
  ADD COLUMN "dedicated_client_protocol" TEXT,
  ADD COLUMN "dedicated_protocol_strategy" TEXT;
