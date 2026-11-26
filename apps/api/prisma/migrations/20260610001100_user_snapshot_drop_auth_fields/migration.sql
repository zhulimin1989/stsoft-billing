-- Billing stores user snapshots only. Authentication credentials, global user
-- roles, login timestamps, and third-party identity bindings belong to the
-- user/auth service.

DROP TABLE IF EXISTS "user_identities";

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "password",
  DROP COLUMN IF EXISTS "role",
  DROP COLUMN IF EXISTS "external_id",
  DROP COLUMN IF EXISTS "last_login_at";

DROP TYPE IF EXISTS "UserRole";
