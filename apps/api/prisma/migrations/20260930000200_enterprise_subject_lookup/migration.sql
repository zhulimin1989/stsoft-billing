-- Single non-transactional statement: Prisma deploy can run CONCURRENTLY.
-- Read-only subject lookup also includes suspended, deleted and quarantined history.
-- Does not replace the existing raw-USCC unique constraint or rewrite historical rows.
CREATE INDEX CONCURRENTLY "billing_accounts_uscc_canonical_lookup_idx"
-- Trim set matches ECMAScript String.trim(), including legacy tabs/NBSP/BOM.
ON "billing_accounts" (upper(btrim("uscc", E' \t\n\r\f\u000b\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')))
WHERE "uscc" IS NOT NULL;
