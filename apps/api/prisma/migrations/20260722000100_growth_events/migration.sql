CREATE TABLE "growth_events" (
    "id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "user_id" TEXT,
    "source" TEXT NOT NULL,
    "source_event_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "analytics_consent" BOOLEAN NOT NULL DEFAULT false,
    "analytics_client_id" TEXT,
    "attribution" JSONB,
    "payload" JSONB NOT NULL,
    "delivery_status" TEXT NOT NULL DEFAULT 'PENDING',
    "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_delivery_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "growth_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "growth_events_dedupe_key_key" ON "growth_events"("dedupe_key");
CREATE INDEX "growth_events_event_name_occurred_at_idx" ON "growth_events"("event_name", "occurred_at");
CREATE INDEX "growth_events_user_id_event_name_idx" ON "growth_events"("user_id", "event_name");
CREATE INDEX "growth_events_delivery_status_created_at_idx" ON "growth_events"("delivery_status", "created_at");
