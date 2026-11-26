-- Support bounded retention deletes on the projection outbox.
--
-- The outbox grows at two rows per guarded request and nothing ever removed a
-- terminal row, so it needs the same retention bound as publisher_sync_jobs.
-- The existing indexes are all keyed on next_run_at or the target, none of
-- which orders the delete; the janitor selects the oldest terminal rows.
--
-- publisher_sync_jobs deliberately gets no new index: it already carries
-- (created_at) and is large enough in production (1.68M rows overseas) that
-- adding one is a heavier operation than the scan it would save, given
-- essentially every row past the retention window is already terminal.
CREATE INDEX IF NOT EXISTS "billing_restriction_projection_intents_retention_idx"
  ON "billing_restriction_projection_intents"("status", "created_at");
