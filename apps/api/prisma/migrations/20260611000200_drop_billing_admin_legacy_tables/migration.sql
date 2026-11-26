-- Billing no longer owns admin authentication, authorization, or admin audit logs.
-- Admin ids that remain on billing records are opaque ids owned by codesphere-admin.

ALTER TABLE "alert_events" DROP CONSTRAINT IF EXISTS "alert_events_handled_by_fkey";

DROP TABLE IF EXISTS "admin_activity_logs" CASCADE;
DROP TABLE IF EXISTS "admin_members" CASCADE;
DROP TABLE IF EXISTS "admin_roles" CASCADE;
