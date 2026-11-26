UPDATE "coding_plan_provider_lines"
SET "dedicated_endpoints" = $json$
[
  {
    "client_protocol": "openai",
    "provider_id": "pc_zhipu_coding_openai",
    "protocol_strategy": "auto",
    "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
    "provider_profile": "openai_compatible",
    "logical_models": ["glm-5.2"],
    "upstream_model": "glm-5.2",
    "client_compatibility": ["openai_sdk"],
    "capabilities": ["chat"],
    "owned_by": "zhipu",
    "priority": 100,
    "weight": 100,
    "status": "active"
  },
  {
    "client_protocol": "responses",
    "provider_id": "pc_zhipu_coding_openai",
    "protocol_strategy": "auto",
    "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
    "provider_profile": "openai_compatible",
    "logical_models": ["glm-5.2"],
    "upstream_model": "glm-5.2",
    "client_compatibility": ["codex"],
    "capabilities": ["chat"],
    "owned_by": "zhipu",
    "priority": 100,
    "weight": 100,
    "status": "active"
  }
]
$json$::jsonb
WHERE "code" IN (
  'zhipu-cn',
  'zhipu_cn',
  'zhipu-oversea',
  'zhipu-overseas',
  'zhipu_overseas'
)
AND "dedicated_endpoints" @> '[{"provider_profile":"anthropic_native"}]'::jsonb
AND "dedicated_endpoints" @> '[{"provider_profile":"openai_compatible"}]'::jsonb;
