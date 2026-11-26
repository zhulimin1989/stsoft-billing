-- Key-balance revisions must order snapshots across every Billing pod. The
-- previous epoch-microsecond generator was monotonic only inside one process,
-- so a delayed snapshot from another pod could overwrite a newer restriction.
--
-- Preserve the deployed epoch-microsecond scale during a rolling deployment:
-- jumping to a permanently reserved high range would stop legacy pods from
-- publishing legitimate later restrictions. The singleton high-water mark is
-- advanced atomically to max(last + 1, database wall-clock microseconds), so
-- new pods are globally ordered while time-synchronised legacy pods remain
-- comparable until the rollout completes.
CREATE TABLE "publisher_key_balance_revision_counter" (
  "singleton" BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK ("singleton"),
  "last_revision" BIGINT NOT NULL CHECK (
    "last_revision" >= 1000000000000000
    AND "last_revision" <= 9007199254740991
  ),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO "publisher_key_balance_revision_counter" (
  "singleton",
  "last_revision",
  "updated_at"
)
VALUES (
  TRUE,
  floor(extract(epoch FROM clock_timestamp()) * 1000000)::BIGINT,
  clock_timestamp()
);

-- Runtime roles only need the fixed, argument-free allocator. UPDATE obtains a
-- row lock, making allocation linearizable across all database sessions. The
-- fully-qualified table and fixed search_path prevent object shadowing.
CREATE FUNCTION "next_publisher_key_balance_revision"()
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocated_revision BIGINT;
BEGIN
  UPDATE public.publisher_key_balance_revision_counter
  SET
    last_revision = GREATEST(
      last_revision + 1,
      floor(extract(epoch FROM clock_timestamp()) * 1000000)::BIGINT
    ),
    updated_at = clock_timestamp()
  WHERE singleton = TRUE
  RETURNING last_revision INTO allocated_revision;

  IF allocated_revision IS NULL THEN
    RAISE EXCEPTION 'publisher key-balance revision counter is missing'
      USING ERRCODE = '55000';
  END IF;
  IF allocated_revision > 9007199254740991 THEN
    RAISE EXCEPTION 'publisher key-balance revision exhausted JavaScript safe integer range'
      USING ERRCODE = '22003';
  END IF;
  RETURN allocated_revision;
END;
$$;

REVOKE ALL ON TABLE "publisher_key_balance_revision_counter" FROM PUBLIC;
REVOKE ALL ON FUNCTION "next_publisher_key_balance_revision"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "next_publisher_key_balance_revision"() TO PUBLIC;

COMMENT ON TABLE "publisher_key_balance_revision_counter" IS
  'Singleton epoch-microsecond high-water mark for globally ordered Publisher key-balance projections.';
COMMENT ON FUNCTION "next_publisher_key_balance_revision"() IS
  'Allocates one cross-pod key-balance revision before the caller reads any balance or restriction state.';
