-- Move dedicated provider-line endpoint intent from client compatibility to served inbound protocols.
WITH normalized_lines AS (
  SELECT
    line."id",
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(endpoint.value) <> 'object' THEN endpoint.value
        ELSE (
          endpoint.value
          - 'client_compatibility'
          - 'clientCompatibility'
          - 'servedInboundProtocols'
          - CASE WHEN endpoint.value->>'protocol_strategy' = 'auto' THEN 'protocol_strategy' ELSE '__noop__' END
          - CASE WHEN endpoint.value->>'protocolStrategy' = 'auto' THEN 'protocolStrategy' ELSE '__noop__' END
        )
        || jsonb_build_object(
          'served_inbound_protocols',
          COALESCE(
            endpoint.value->'served_inbound_protocols',
            endpoint.value->'servedInboundProtocols',
            CASE lower(COALESCE(endpoint.value->>'client_protocol', endpoint.value->>'clientProtocol', ''))
              WHEN 'anthropic' THEN '["anthropic"]'::jsonb
              WHEN 'openai' THEN '["openai"]'::jsonb
              WHEN 'responses' THEN '["responses"]'::jsonb
              ELSE '[]'::jsonb
            END
          )
        )
      END
      ORDER BY endpoint.ordinality
    ) AS dedicated_endpoints
  FROM "coding_plan_provider_lines" line
  CROSS JOIN LATERAL jsonb_array_elements(line."dedicated_endpoints") WITH ORDINALITY AS endpoint(value, ordinality)
  WHERE jsonb_typeof(line."dedicated_endpoints") = 'array'
  GROUP BY line."id"
)
UPDATE "coding_plan_provider_lines" line
SET
  "dedicated_endpoints" = normalized_lines.dedicated_endpoints,
  "updated_at" = now()
FROM normalized_lines
WHERE line."id" = normalized_lines."id";

-- Existing generated pc_* dedicated providers need the merged dialect list in ProductChannel metadata
-- because runtime publish builds client_exposures from ProductChannel, not from provider-line JSON.
WITH endpoint_protocols AS (
  SELECT DISTINCT
    endpoint.value->>'provider_id' AS provider_id,
    lower(COALESCE(protocol.value, '')) AS protocol
  FROM "coding_plan_provider_lines" line
  CROSS JOIN LATERAL jsonb_array_elements(line."dedicated_endpoints") AS endpoint(value)
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(
      endpoint.value->'served_inbound_protocols',
      CASE lower(COALESCE(endpoint.value->>'client_protocol', endpoint.value->>'clientProtocol', ''))
        WHEN 'anthropic' THEN '["anthropic"]'::jsonb
        WHEN 'openai' THEN '["openai"]'::jsonb
        WHEN 'responses' THEN '["responses"]'::jsonb
        ELSE '[]'::jsonb
      END
    )
  ) AS protocol(value)
  WHERE jsonb_typeof(line."dedicated_endpoints") = 'array'
    AND endpoint.value->>'provider_id' LIKE 'pc\_%' ESCAPE '\'
),
provider_protocols AS (
  SELECT
    provider_id,
    jsonb_agg(
      protocol
      ORDER BY CASE protocol
        WHEN 'openai' THEN 1
        WHEN 'responses' THEN 2
        WHEN 'anthropic' THEN 3
        WHEN 'gemini' THEN 4
        ELSE 99
      END
    ) AS served_inbound_protocols
  FROM endpoint_protocols
  WHERE protocol IN ('anthropic', 'gemini', 'openai', 'responses')
  GROUP BY provider_id
)
UPDATE "product_channels" pc
SET
  "metadata" = jsonb_set(
    jsonb_set(
      COALESCE(pc."metadata", '{}'::jsonb),
      '{dedicated_runtime}',
      COALESCE(pc."metadata"->'dedicated_runtime', pc."metadata"->'dedicatedRuntime', '{}'::jsonb),
      true
    ),
    '{dedicated_runtime,served_inbound_protocols}',
    provider_protocols.served_inbound_protocols,
    true
  ),
  "updated_at" = now()
FROM provider_protocols
WHERE provider_protocols.provider_id = 'pc_' || pc."id"
  AND (
    pc."metadata" ? 'dedicated_runtime'
    OR pc."metadata" ? 'dedicatedRuntime'
  );
