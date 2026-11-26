-- Provider-account identity is deliberately separate from credentials. A key
-- can rotate without changing the stable account reference used for runtime
-- usage attribution and provider reconciliation.
CREATE TABLE "provider_account_identities" (
    "id" TEXT NOT NULL,
    "provider_account_ref" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_account_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_account_identities_ref_format_check" CHECK (
      "provider_account_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
    CONSTRAINT "provider_account_identities_provider_code_check" CHECK (
      "provider_code" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    ),
    CONSTRAINT "provider_account_identities_display_name_check" CHECK (
      "display_name" = btrim("display_name")
      AND char_length("display_name") BETWEEN 1 AND 128
    ),
    CONSTRAINT "provider_account_identities_status_check" CHECK (
      "status" IN ('active', 'inactive')
    )
);

CREATE UNIQUE INDEX "provider_account_identities_provider_account_ref_key"
    ON "provider_account_identities"("provider_account_ref");

CREATE INDEX "provider_account_identities_provider_code_status_idx"
    ON "provider_account_identities"("provider_code", "status");

ALTER TABLE "channels"
    ADD COLUMN "provider_account_identity_id" TEXT;

ALTER TABLE "coding_plan_provider_entitlements"
    ADD COLUMN "provider_account_identity_id" TEXT;

ALTER TABLE "coding_plan_provider_lines"
    ADD COLUMN "provider_account_identity_id" TEXT;

CREATE INDEX "channels_provider_account_identity_id_idx"
    ON "channels"("provider_account_identity_id");

CREATE INDEX "coding_plan_provider_entitlement_account_identity_idx"
    ON "coding_plan_provider_entitlements"("provider_account_identity_id");

CREATE INDEX "coding_plan_provider_line_account_identity_idx"
    ON "coding_plan_provider_lines"("provider_account_identity_id");

ALTER TABLE "channels"
    ADD CONSTRAINT "channels_provider_account_identity_id_fkey"
    FOREIGN KEY ("provider_account_identity_id")
    REFERENCES "provider_account_identities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coding_plan_provider_entitlements"
    ADD CONSTRAINT "coding_plan_provider_entitlement_account_identity_fkey"
    FOREIGN KEY ("provider_account_identity_id")
    REFERENCES "provider_account_identities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coding_plan_provider_lines"
    ADD CONSTRAINT "coding_plan_provider_line_account_identity_fkey"
    FOREIGN KEY ("provider_account_identity_id")
    REFERENCES "provider_account_identities"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Canonicalization mirrors the control-plane rule used by Billing and
-- Publisher. Keeping it in one SQL helper makes every trigger compare the same
-- provider ownership evidence, including the historical moonshot alias.
CREATE FUNCTION "provider_account_canonical_code"("raw_code" TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    "normalized_code" TEXT;
BEGIN
    IF "raw_code" IS NULL OR btrim("raw_code") = '' THEN
        RETURN NULL;
    END IF;

    "normalized_code" := regexp_replace(
        lower(btrim("raw_code")),
        '[^a-z0-9._-]+',
        '-',
        'g'
    );
    IF "normalized_code" = 'moonshot' THEN
        RETURN 'kimi';
    END IF;
    RETURN "normalized_code";
END;
$$;

-- This trigger is the final authority for every identity binding. FOR SHARE
-- is held until the child transaction commits, so a concurrent identity
-- deactivation cannot pass between application validation and the child write.
CREATE FUNCTION "validate_provider_account_identity_binding"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    "expected_provider_code" TEXT;
    "line_provider_account_identity_id" TEXT;
    "identity_provider_code" TEXT;
    "identity_status" TEXT;
BEGIN
    -- A provider-line provider change is also serialized against entitlement
    -- binding: entitlement validation takes FOR SHARE on this provider line.
    IF TG_TABLE_NAME = 'coding_plan_provider_lines' AND TG_OP = 'UPDATE' THEN
        IF "provider_account_canonical_code"(OLD."provider_code")
            IS DISTINCT FROM "provider_account_canonical_code"(NEW."provider_code")
            AND EXISTS (
                SELECT 1
                FROM "coding_plan_provider_entitlements" AS "entitlement"
                WHERE "entitlement"."provider_line_id" = OLD."id"
            )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'coding_plan_provider_line_provider_change_has_entitlements',
                CONSTRAINT = 'coding_plan_provider_line_provider_change_guard';
        END IF;
        IF OLD."provider_account_identity_id" IS DISTINCT FROM NEW."provider_account_identity_id"
            AND EXISTS (
                SELECT 1
                FROM "coding_plan_provider_entitlements" AS "entitlement"
                WHERE "entitlement"."provider_line_id" = OLD."id"
                  AND (
                    OLD."provider_account_identity_id" IS NOT NULL
                    OR NEW."provider_account_identity_id" IS NULL
                    OR "entitlement"."provider_account_identity_id" IS NOT NULL
                       AND "entitlement"."provider_account_identity_id"
                           IS DISTINCT FROM NEW."provider_account_identity_id"
                  )
            )
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'coding_plan_provider_line_identity_change_has_entitlements',
                CONSTRAINT = 'coding_plan_provider_line_identity_change_guard';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'coding_plan_provider_entitlements' THEN
        IF NEW."status" = 'ACTIVE' AND NEW."provider_account_identity_id" IS NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'active_provider_entitlement_identity_required',
                CONSTRAINT = 'active_provider_entitlement_identity_required_guard';
        END IF;
    END IF;

    IF NEW."provider_account_identity_id" IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'channels' THEN
        "expected_provider_code" := "provider_account_canonical_code"(NEW."provider");
    ELSIF TG_TABLE_NAME = 'coding_plan_provider_lines' THEN
        "expected_provider_code" := "provider_account_canonical_code"(NEW."provider_code");
    ELSIF TG_TABLE_NAME = 'coding_plan_provider_entitlements' THEN
        -- The live ProviderLine is authoritative; entitlement provider_code
        -- and provider are snapshots only. Locking it closes the concurrent
        -- provider-line-change race before the identity row is locked.
        SELECT
            "provider_account_canonical_code"("line"."provider_code"),
            "line"."provider_account_identity_id"
        INTO "expected_provider_code", "line_provider_account_identity_id"
        FROM "coding_plan_provider_lines" AS "line"
        WHERE "line"."id" = NEW."provider_line_id"
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                ERRCODE = '23503',
                MESSAGE = 'coding_plan_provider_line_not_found',
                CONSTRAINT = 'coding_plan_provider_entitlements_provider_line_id_fkey';
        END IF;
        IF "line_provider_account_identity_id" IS NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'provider_account_identity_provider_line_identity_missing',
                CONSTRAINT = 'provider_account_identity_provider_line_inheritance_guard';
        END IF;
        IF NEW."provider_account_identity_id"
            IS DISTINCT FROM "line_provider_account_identity_id"
        THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'provider_account_identity_provider_line_identity_mismatch',
                CONSTRAINT = 'provider_account_identity_provider_line_inheritance_guard';
        END IF;
    ELSE
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'unsupported_provider_account_identity_binding_table';
    END IF;

    IF "expected_provider_code" IS NULL OR "expected_provider_code" = '' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'provider_account_identity_expected_provider_missing',
            CONSTRAINT = 'provider_account_identity_provider_ownership_guard';
    END IF;

    SELECT
        "provider_account_canonical_code"("identity"."provider_code"),
        "identity"."status"
    INTO "identity_provider_code", "identity_status"
    FROM "provider_account_identities" AS "identity"
    WHERE "identity"."id" = NEW."provider_account_identity_id"
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            ERRCODE = '23503',
            MESSAGE = 'provider_account_identity_not_found',
            CONSTRAINT = 'provider_account_identity_binding_fkey';
    END IF;
    IF "identity_status" <> 'active' THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'provider_account_identity_inactive',
            CONSTRAINT = 'provider_account_identity_active_binding_guard';
    END IF;
    IF "identity_provider_code" IS DISTINCT FROM "expected_provider_code" THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'provider_account_identity_provider_mismatch',
            DETAIL = format(
                'identity_provider=%s expected_provider=%s',
                "identity_provider_code",
                "expected_provider_code"
            ),
            CONSTRAINT = 'provider_account_identity_provider_ownership_guard';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "channels_provider_account_identity_binding_guard"
BEFORE INSERT OR UPDATE OF "provider_account_identity_id", "provider"
ON "channels"
FOR EACH ROW
EXECUTE FUNCTION "validate_provider_account_identity_binding"();

-- Restoring a soft-deleted Channel makes it a live blocker again and must
-- revalidate the identity that may have been deactivated while it was deleted.
CREATE TRIGGER "channels_provider_account_identity_restore_guard"
BEFORE UPDATE OF "deleted_at"
ON "channels"
FOR EACH ROW
WHEN (NEW."deleted_at" IS NULL AND NEW."provider_account_identity_id" IS NOT NULL)
EXECUTE FUNCTION "validate_provider_account_identity_binding"();

CREATE TRIGGER "coding_plan_provider_lines_account_identity_binding_guard"
BEFORE INSERT OR UPDATE OF "provider_account_identity_id", "provider_code"
ON "coding_plan_provider_lines"
FOR EACH ROW
EXECUTE FUNCTION "validate_provider_account_identity_binding"();

CREATE TRIGGER "coding_plan_provider_entitlement_identity_bind_guard"
BEFORE INSERT OR UPDATE OF
    "provider_account_identity_id",
    "provider_line_id",
    "provider_code",
    "provider"
ON "coding_plan_provider_entitlements"
FOR EACH ROW
EXECUTE FUNCTION "validate_provider_account_identity_binding"();

-- An inactive entitlement may retain historical attribution after identity
-- deactivation, but it cannot become ACTIVE again without a live identity.
CREATE TRIGGER "coding_plan_provider_entitlement_identity_active_guard"
BEFORE UPDATE OF "status"
ON "coding_plan_provider_entitlements"
FOR EACH ROW
WHEN (NEW."status" = 'ACTIVE')
EXECUTE FUNCTION "validate_provider_account_identity_binding"();

-- Updating an identity row already owns a conflicting row lock. The final
-- reference check below therefore runs after any earlier child FOR SHARE lock,
-- while later child bindings wait and then observe status=inactive.
CREATE FUNCTION "enforce_provider_account_identity_lifecycle"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."provider_account_ref" IS DISTINCT FROM OLD."provider_account_ref"
        OR NEW."provider_code" IS DISTINCT FROM OLD."provider_code"
    THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'provider_account_identity_immutable_fields',
            CONSTRAINT = 'provider_account_identity_immutable_fields_guard';
    END IF;

    IF NEW."status" = 'inactive' AND OLD."status" IS DISTINCT FROM 'inactive' THEN
        IF EXISTS (
            SELECT 1
            FROM "channels" AS "channel"
            WHERE "channel"."provider_account_identity_id" = OLD."id"
              AND "channel"."deleted_at" IS NULL
        ) OR EXISTS (
            SELECT 1
            FROM "coding_plan_provider_lines" AS "line"
            WHERE "line"."provider_account_identity_id" = OLD."id"
        ) OR EXISTS (
            SELECT 1
            FROM "coding_plan_provider_entitlements" AS "entitlement"
            WHERE "entitlement"."provider_account_identity_id" = OLD."id"
              AND "entitlement"."status" = 'ACTIVE'
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'provider_account_identity_has_blocking_references',
                CONSTRAINT = 'provider_account_identity_no_blocking_references';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "provider_account_identities_lifecycle_guard"
BEFORE UPDATE OF "id", "provider_account_ref", "provider_code", "status"
ON "provider_account_identities"
FOR EACH ROW
EXECUTE FUNCTION "enforce_provider_account_identity_lifecycle"();
