-- TG_TABLE_NAME is a name with C collation. Passing it unmodified gives the
-- helper's text locals C collation too, preventing use of default-collation indexes.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.assert_clean_account_wallet_canonical_deferred()'::regprocedure);
  original constant text := E'IF gateway_balance_canonical_mutation_is_current_settlement(\n    TG_TABLE_NAME,';
  corrected constant text := E'IF gateway_balance_canonical_mutation_is_current_settlement(\n    TG_TABLE_NAME::text COLLATE pg_catalog."default",';
BEGIN
  IF cardinality(string_to_array(definition, corrected)) = 2 AND strpos(definition, original) = 0 THEN
    RETURN; -- Already installed by greenfield contract activation.
  END IF;
  IF cardinality(string_to_array(definition, original)) <> 2 OR strpos(definition, corrected) <> 0 THEN
    RAISE EXCEPTION 'Unexpected deferred settlement proof call site';
  END IF;
  EXECUTE replace(definition, original, corrected);
END;
$migration$;
