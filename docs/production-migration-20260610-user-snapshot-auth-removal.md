# Production Migration: User Snapshot Auth Removal

Date: 2026-06-10

## Scope

Billing now treats `users` as a user snapshot table. It no longer owns user
authentication, global user roles, login timestamps, or third-party identity
bindings.

This migration removes:

- `users.password`
- `users.role`
- `users.external_id`
- `users.last_login_at`
- `user_identities`
- PostgreSQL enum type `UserRole`

At the time of this migration, admin operator authentication was unchanged.
That remaining billing-side admin legacy surface was later removed by
`20260611000200_drop_billing_admin_legacy_tables`; see
`docs/production-migration-20260611-drop-billing-admin-legacy.md`.

## Optional Backup

If you want a short rollback window before running the migration, export the
legacy columns first:

```sql
create table if not exists users_auth_legacy_backup_20260610 as
select id, email, phone, password, role, external_id, last_login_at
from users;

create table if not exists user_identities_backup_20260610 as
select *
from user_identities;
```

## Deployment Order

1. Deploy this billing code. The old `AuthModule`, `UserModule`, `MemberModule`,
   full `AppModule`, `admin-main`, and legacy `/sync/*` implementation have been
   removed from the billing API package.
2. Run billing Prisma migrations:
   `pnpm --filter @ruidong/api prisma:migrate:billing`.
3. Verify the legacy user-auth surface is gone:

```sql
select column_name
from information_schema.columns
where table_name = 'users'
  and column_name in ('password', 'role', 'external_id', 'last_login_at');

select to_regclass('public.user_identities') as user_identities_table;

select typname
from pg_type
where typname = 'UserRole';
```

Expected results: no rows for the first and third queries; `null` for
`user_identities_table`.

## Data Migration Notes

No billing-owned data needs to be transformed. If any downstream process still
reads the removed fields, migrate it to the user service before applying this
migration.
