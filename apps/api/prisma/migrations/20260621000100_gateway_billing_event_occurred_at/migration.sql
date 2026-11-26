ALTER TABLE "gateway_billing_events"
ADD COLUMN "occurred_at" TIMESTAMP(3);

UPDATE "gateway_billing_events"
SET "occurred_at" = COALESCE(
  CASE
    WHEN "raw_event" ? 'timestamp'
      AND "raw_event"->>'timestamp' ~ '^\d+$'
      AND length("raw_event"->>'timestamp') >= 18
      THEN to_timestamp(("raw_event"->>'timestamp')::numeric / 1000000000) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'timestamp'
      AND "raw_event"->>'timestamp' ~ '^\d+$'
      AND length("raw_event"->>'timestamp') >= 15
      THEN to_timestamp(("raw_event"->>'timestamp')::numeric / 1000000) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'timestamp'
      AND "raw_event"->>'timestamp' ~ '^\d+$'
      AND length("raw_event"->>'timestamp') >= 12
      THEN to_timestamp(("raw_event"->>'timestamp')::numeric / 1000) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'timestamp'
      AND "raw_event"->>'timestamp' ~ '^\d+$'
      THEN to_timestamp(("raw_event"->>'timestamp')::numeric) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'timestamp'
      AND "raw_event"->>'timestamp' ~ '^\d{4}-\d{2}-\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
      THEN ("raw_event"->>'timestamp')::timestamptz AT TIME ZONE 'UTC'
    ELSE NULL
  END,
  CASE
    WHEN "raw_event" ? 'occurred_at'
      AND "raw_event"->>'occurred_at' ~ '^\d{4}-\d{2}-\d{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}'
      THEN ("raw_event"->>'occurred_at')::timestamptz AT TIME ZONE 'UTC'
    ELSE NULL
  END,
  CASE
    WHEN "raw_event" ? 'ts'
      AND "raw_event"->>'ts' ~ '^\d+$'
      AND length("raw_event"->>'ts') >= 18
      THEN to_timestamp(("raw_event"->>'ts')::numeric / 1000000000) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'ts'
      AND "raw_event"->>'ts' ~ '^\d+$'
      AND length("raw_event"->>'ts') >= 15
      THEN to_timestamp(("raw_event"->>'ts')::numeric / 1000000) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'ts'
      AND "raw_event"->>'ts' ~ '^\d+$'
      AND length("raw_event"->>'ts') >= 12
      THEN to_timestamp(("raw_event"->>'ts')::numeric / 1000) AT TIME ZONE 'UTC'
    WHEN "raw_event" ? 'ts'
      AND "raw_event"->>'ts' ~ '^\d+$'
      THEN to_timestamp(("raw_event"->>'ts')::numeric) AT TIME ZONE 'UTC'
    ELSE NULL
  END
)
WHERE "occurred_at" IS NULL;

CREATE INDEX "gateway_billing_events_occurred_at_idx"
ON "gateway_billing_events"("occurred_at");

CREATE INDEX "gateway_billing_events_status_occurred_at_idx"
ON "gateway_billing_events"("status", "occurred_at");
