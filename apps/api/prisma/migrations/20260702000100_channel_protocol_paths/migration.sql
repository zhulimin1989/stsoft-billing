ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "protocol_paths" JSONB;

WITH parsed AS (
  SELECT
    id,
    COALESCE(NULLIF(provider_profile, ''), 'openai_compatible') AS provider_profile,
    CASE
      WHEN served_inbound_protocols IS NULL OR btrim(served_inbound_protocols) = '' THEN '[]'::jsonb
      WHEN btrim(served_inbound_protocols) LIKE '[%' THEN served_inbound_protocols::jsonb
      ELSE to_jsonb(regexp_split_to_array(served_inbound_protocols, '\s*,\s*'))
    END AS protocols
  FROM "channels"
  WHERE protocol_paths IS NULL
),
paths AS (
  SELECT
    parsed.id,
    jsonb_agg(
      jsonb_build_object(
        'inbound_protocol',
        protocol,
        'channel',
        CASE
          WHEN (
            CASE
              WHEN parsed.provider_profile = 'anthropic_native' THEN 'anthropic'
              WHEN parsed.provider_profile = 'gemini_native' THEN 'gemini'
              WHEN parsed.provider_profile = 'openai_responses_native' THEN 'responses'
              ELSE 'openai'
            END
          ) = protocol THEN 'passthrough'
          WHEN parsed.provider_profile NOT IN ('anthropic_native', 'gemini_native', 'openai_responses_native')
            AND protocol = 'responses' THEN 'responses_to_chat'
          WHEN parsed.provider_profile NOT IN ('anthropic_native', 'gemini_native', 'openai_responses_native')
            AND protocol = 'anthropic' THEN 'anthropic_to_chat'
          ELSE 'passthrough'
        END
      )
      ORDER BY ord
    ) AS protocol_paths
  FROM parsed
  CROSS JOIN LATERAL jsonb_array_elements_text(parsed.protocols) WITH ORDINALITY AS item(protocol, ord)
  WHERE protocol IN ('anthropic', 'gemini', 'openai', 'responses')
  GROUP BY parsed.id
)
UPDATE "channels" AS c
SET protocol_paths = paths.protocol_paths
FROM paths
WHERE c.id = paths.id
  AND jsonb_array_length(paths.protocol_paths) > 0;
