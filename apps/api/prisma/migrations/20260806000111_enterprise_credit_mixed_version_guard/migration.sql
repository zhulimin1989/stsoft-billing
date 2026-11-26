-- Zero-downtime mixed-version guard. Existing revision-0 rows are retained,
-- but every new INSERT/UPDATE is checked. An old binary cannot grant or alter
-- credit while silently omitting the revision/boundary protocol.
ALTER TABLE "billing_account_credit_configs"
  ADD CONSTRAINT "billing_account_credit_configs_revision_zero_safe_check"
    CHECK (
      "policy_revision" <> 0
      OR (
        "limit_usd" = 0
        AND "status" = 'DISABLED'
        AND "terms_days" IS NULL
        AND "effective_at" IS NULL
        AND "expires_at" IS NULL
        AND NOT "policy_boundary_complete"
        AND "policy_effective_boundary_at" IS NULL
      )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_enterprise_credit_policy_revision()
RETURNS trigger AS $$
DECLARE
  policy_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."policy_revision" = 0 THEN
      IF NEW."limit_usd" <> 0
         OR NEW."status" <> 'DISABLED'
         OR NEW."terms_days" IS NOT NULL
         OR NEW."effective_at" IS NOT NULL
         OR NEW."expires_at" IS NOT NULL
         OR NEW."policy_boundary_complete"
         OR NEW."policy_effective_boundary_at" IS NOT NULL THEN
        RAISE EXCEPTION 'enterprise credit INSERT requires revision protocol'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW."policy_revision" <> 1
       OR NEW."policy_boundary_complete"
       OR NEW."policy_effective_boundary_at" IS NOT NULL THEN
      RAISE EXCEPTION 'enterprise credit initial revision must be 1 and pending'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  policy_changed := ROW(
    NEW."limit_usd",
    NEW."status",
    NEW."terms_days",
    NEW."effective_at",
    NEW."expires_at"
  ) IS DISTINCT FROM ROW(
    OLD."limit_usd",
    OLD."status",
    OLD."terms_days",
    OLD."effective_at",
    OLD."expires_at"
  );

  IF NEW."policy_revision" = OLD."policy_revision" + 1 THEN
    IF NEW."policy_boundary_complete"
       OR NEW."policy_effective_boundary_at" IS NOT NULL THEN
      RAISE EXCEPTION 'enterprise credit new revision must start pending'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."policy_revision" <> OLD."policy_revision" THEN
    RAISE EXCEPTION 'enterprise credit policy revision must advance by exactly one'
      USING ERRCODE = '23514';
  END IF;

  IF policy_changed THEN
    RAISE EXCEPTION 'enterprise credit policy change requires a new revision'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."policy_boundary_complete" THEN
    IF NOT NEW."policy_boundary_complete"
       OR NEW."policy_effective_boundary_at" IS DISTINCT FROM OLD."policy_effective_boundary_at" THEN
      RAISE EXCEPTION 'enterprise credit confirmed boundary is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."policy_boundary_complete" THEN
    IF NEW."policy_revision" <= 0
       OR NEW."policy_effective_boundary_at" IS NULL THEN
      RAISE EXCEPTION 'enterprise credit boundary confirmation is incomplete'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."policy_effective_boundary_at" IS NOT NULL THEN
    RAISE EXCEPTION 'enterprise credit pending boundary timestamp must be null'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_account_credit_configs_revision_guard
  BEFORE INSERT OR UPDATE ON "billing_account_credit_configs"
  FOR EACH ROW EXECUTE FUNCTION enforce_enterprise_credit_policy_revision();
