UPDATE "coding_plan_provider_lines"
SET "dedicated_endpoints" = COALESCE((
  SELECT jsonb_agg(
    CASE
      WHEN COALESCE(endpoint->>'client_protocol', endpoint->>'clientProtocol') = 'anthropic'
        OR COALESCE(endpoint->>'provider_id', endpoint->>'providerId') IN ('glm-anthropic', 'glm-anthropic-dedicated')
      THEN endpoint || jsonb_build_object(
        'base_url', 'https://open.bigmodel.cn/api/anthropic',
        'provider_profile', 'anthropic_native'
      )
      WHEN COALESCE(endpoint->>'client_protocol', endpoint->>'clientProtocol') = 'openai'
        OR COALESCE(endpoint->>'provider_id', endpoint->>'providerId') IN ('glm-openai', 'glm-openai-dedicated')
      THEN endpoint || jsonb_build_object(
        'base_url', 'https://open.bigmodel.cn/api/coding/paas/v4',
        'provider_profile', 'glm_coding'
      )
      ELSE endpoint
    END
    ORDER BY ordinality
  )
  FROM jsonb_array_elements("coding_plan_provider_lines"."dedicated_endpoints") WITH ORDINALITY AS source(endpoint, ordinality)
), '[]'::jsonb)
WHERE "code" IN ('zhipu_overseas', 'zhipu_cn', 'zhipu-oversea', 'zhipu-cn')
  AND "dedicated_endpoints" IS NOT NULL
  AND jsonb_typeof("dedicated_endpoints") = 'array';
