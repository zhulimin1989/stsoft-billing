# Production Migration: Billing Identity Snapshot Hardening

Date: 2026-06-10

## Scope

This migration moves the billing runtime closer to the target boundary where
billing stores user and tenant snapshots, not authentication data.

Changes:

- Add `users.source_updated_at`, `users.mirrored_at`.
- Add `tenants.source_updated_at`, `tenants.mirrored_at`.
- Clear existing legacy `users.password` values in the billing database.
- Set `users.password` default to an empty string so legacy compile-time code can
  coexist while billing-runtime mirror paths stop writing credentials.

## Deployment Order

1. Deploy the billing code that stops writing `password` and `role` from
   billing-runtime mirror paths.
2. Run Prisma migrations for billing:
   `pnpm db:migrate:prod`.
3. Confirm existing billing user snapshot rows have no credential values:

   ```sql
   select count(*) as users_with_password
   from users
   where password is distinct from '';
   ```

   Expected result: `0`.

4. Confirm snapshot timestamps are populated:

   ```sql
   select count(*) as users_missing_mirrored_at
   from users
   where mirrored_at is null;

   select count(*) as tenants_missing_mirrored_at
   from tenants
   where mirrored_at is null;
   ```

   Expected result for both queries: `0`.

## Follow-up

The old full-app user/auth modules have since been removed from this repo. The
follow-up migration is documented in
`docs/production-migration-20260610-user-snapshot-auth-removal.md` and drops
`users.password`, `users.role`, `users.external_id`, `users.last_login_at`, and
`user_identities`.
