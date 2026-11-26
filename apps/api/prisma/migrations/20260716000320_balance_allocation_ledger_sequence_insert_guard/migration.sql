-- Allocation order is a database-owned financial fact. A DEFAULT alone can
-- be overridden by an explicit INSERT, which would let a caller forge FIFO
-- debt order. Keep historical repair on UPDATE untouched; every new row gets
-- a fresh positive sequence from PostgreSQL regardless of supplied input.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION "guard_balance_allocation_ledger_sequence_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."ledger_sequence" := nextval(
    'balance_consumption_allocation_ledger_seq'::regclass
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "balance_allocations_ledger_sequence_insert_guard"
  ON "balance_consumption_allocations";
CREATE TRIGGER "balance_allocations_ledger_sequence_insert_guard"
BEFORE INSERT ON "balance_consumption_allocations"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_allocation_ledger_sequence_insert"();

COMMIT;
