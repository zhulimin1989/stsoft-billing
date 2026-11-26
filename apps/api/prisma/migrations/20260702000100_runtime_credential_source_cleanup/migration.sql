-- Retire product runtime credential_source legacy names and clear the retired
-- product-level protocol strategy column.
ALTER TABLE "product_runtime_policies"
  ALTER COLUMN "credential_source" SET DEFAULT 'keypool';

UPDATE "product_runtime_policies"
SET "credential_source" = CASE "credential_source"
  WHEN 'platform_pool' THEN 'keypool'
  WHEN 'provider_entitlement' THEN 'dedicated_upstream'
  ELSE "credential_source"
END
WHERE "credential_source" IN ('platform_pool', 'provider_entitlement');

ALTER TABLE "product_runtime_policies"
  ALTER COLUMN "protocol_strategy" DROP DEFAULT,
  ALTER COLUMN "protocol_strategy" DROP NOT NULL;

UPDATE "product_runtime_policies"
SET "protocol_strategy" = NULL
WHERE "protocol_strategy" = 'auto';

-- Materialize the provider-line relationship for dedicated ProductChannel
-- rows. The runtime provider id remains pc_<product_channels.id>; the FK
-- gives the database a real edge from that ProductChannel back to the owning
-- CodingPlanProviderLine.
ALTER TABLE "product_channels"
  ADD COLUMN "provider_line_id" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coding_plan_provider_lines" line
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(line."dedicated_endpoints") = 'array' THEN line."dedicated_endpoints"
        ELSE '[]'::jsonb
      END
    ) endpoint(value)
    WHERE line."runtime_enabled" = true
      AND COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId') LIKE 'pc\_%' ESCAPE '\'
    GROUP BY COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId')
    HAVING COUNT(DISTINCT line."id") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot backfill ProductChannel provider_line_id: one pc_* runtime provider is referenced by multiple provider lines';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "coding_plan_provider_lines" line
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(line."dedicated_endpoints") = 'array' THEN line."dedicated_endpoints"
        ELSE '[]'::jsonb
      END
    ) endpoint(value)
    LEFT JOIN "product_channels" pc
      ON COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId') = 'pc_' || pc."id"
    WHERE line."runtime_enabled" = true
      AND COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId') LIKE 'pc\_%' ESCAPE '\'
      AND pc."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot backfill ProductChannel provider_line_id: dedicated endpoint references a missing pc_* ProductChannel';
  END IF;
END $$;

WITH endpoint_lines AS (
  SELECT
    COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId') AS provider_id,
    MIN(line."id") AS provider_line_id
  FROM "coding_plan_provider_lines" line
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(line."dedicated_endpoints") = 'array' THEN line."dedicated_endpoints"
      ELSE '[]'::jsonb
    END
  ) endpoint(value)
  WHERE line."runtime_enabled" = true
    AND COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId') LIKE 'pc\_%' ESCAPE '\'
  GROUP BY COALESCE(endpoint.value->>'provider_id', endpoint.value->>'providerId')
),
metadata_line_refs AS (
  SELECT
    pc."id" AS product_channel_id,
    COALESCE(
      pc."metadata"#>>'{provider_line,id}',
      pc."metadata"#>>'{providerLine,id}',
      pc."metadata"#>>'{provider_line_id}',
      pc."metadata"#>>'{providerLineId}'
    ) AS provider_line_id
  FROM "product_channels" pc
),
metadata_lines AS (
  SELECT
    refs.product_channel_id,
    line."id" AS provider_line_id
  FROM metadata_line_refs refs
  JOIN "coding_plan_provider_lines" line
    ON line."id" = refs.provider_line_id
)
UPDATE "product_channels" pc
SET "provider_line_id" = COALESCE(metadata_lines.provider_line_id, endpoint_lines.provider_line_id)
FROM metadata_lines
LEFT JOIN endpoint_lines
  ON endpoint_lines.provider_id = 'pc_' || metadata_lines.product_channel_id
WHERE pc."id" = metadata_lines.product_channel_id
  AND COALESCE(metadata_lines.provider_line_id, endpoint_lines.provider_line_id) IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "product_channels" pc
    LEFT JOIN "coding_plan_provider_lines" line
      ON line."id" = pc."provider_line_id"
    WHERE pc."provider_line_id" IS NOT NULL
      AND line."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add ProductChannel provider_line_id FK: backfilled provider line is missing';
  END IF;
END $$;

CREATE INDEX "product_channels_provider_line_id_idx"
  ON "product_channels"("provider_line_id");

ALTER TABLE "product_channels"
  ADD CONSTRAINT "product_channels_provider_line_id_fkey"
  FOREIGN KEY ("provider_line_id")
  REFERENCES "coding_plan_provider_lines"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
