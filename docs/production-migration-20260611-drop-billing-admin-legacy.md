# Production migration: drop billing admin legacy tables

Date: 2026-06-11

## What changes

`codesphere-billing` no longer owns admin authentication, admin roles, or admin
operation audit logs. Admin-facing billing APIs must be called through
`codesphere-admin`, which forwards the resolved admin id and permissions over
the internal billing client.

The migration `20260611000200_drop_billing_admin_legacy_tables` removes:

- `admin_activity_logs`
- `admin_members`
- `admin_roles`
- the foreign key from `alert_events.handled_by` to `admin_members`

`alert_events.handled_by`, ticket assignee ids, and admin-authored ticket
message author ids remain as opaque admin ids owned by `codesphere-admin`.

## Pre-deploy checks

1. Confirm `codesphere-admin` has the production admin accounts, roles, and
   activity-log retention you want to keep.
2. If old billing-side `admin_activity_logs` must be preserved, export them
   before applying the billing migration:

   ```sql
   COPY (
     SELECT * FROM admin_activity_logs ORDER BY created_at
   ) TO STDOUT WITH CSV HEADER;
   ```

3. If old billing-side `admin_members` or `admin_roles` contain accounts not
   already present in `codesphere-admin`, manually recreate or import them into
   the admin database before cutting over. Password hashes should not be moved
   blindly unless you have verified the same hashing and password policy.

## Deploy order

1. Deploy `codesphere-admin` with billing internal-client forwarding enabled.
2. Deploy `codesphere-billing`.
3. Apply billing migrations.
4. Smoke test an admin billing action through `codesphere-admin`, such as
   listing orders or updating a billing plan/channel, and confirm billing
   receives `x-admin-id` plus `x-admin-permissions`.

## Rollback note

Rollback would require restoring the three dropped tables from backup. The
preferred rollback is to restore the billing database snapshot taken before the
migration.
