CREATE OR REPLACE FUNCTION billing_strip_channel_model_config_capability_overrides(raw text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  parsed jsonb;
  stripped jsonb;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN raw;
  END IF;

  BEGIN
    parsed := raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN raw;
  END;

  IF jsonb_typeof(parsed) <> 'object' THEN
    RETURN raw;
  END IF;

  SELECT COALESCE(
    jsonb_object_agg(key, next_value) FILTER (
      WHERE NOT (jsonb_typeof(next_value) = 'object' AND next_value = '{}'::jsonb)
    ),
    '{}'::jsonb
  )
  INTO stripped
  FROM (
    SELECT
      key,
      CASE
        WHEN jsonb_typeof(value) = 'object'
          THEN value - 'capabilityOverrides' - 'capability_overrides'
        ELSE value
      END AS next_value
    FROM jsonb_each(parsed)
  ) entries;

  RETURN stripped::text;
END;
$$;

UPDATE "channels"
SET "model_configs" = billing_strip_channel_model_config_capability_overrides("model_configs")
WHERE "model_configs" IS NOT NULL
  AND (
    "model_configs" LIKE '%capabilityOverrides%'
    OR "model_configs" LIKE '%capability_overrides%'
  );

DROP FUNCTION billing_strip_channel_model_config_capability_overrides(text);

ALTER TABLE "product_runtime_policies"
  DROP COLUMN IF EXISTS "allowed_provider_profiles";
