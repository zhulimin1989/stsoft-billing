ALTER TABLE "coding_plan_provider_lines"
  ADD COLUMN "dedicated_endpoints" JSONB;

UPDATE "coding_plan_provider_lines"
SET "dedicated_endpoints" = '[
  {
    "client_protocol": "anthropic",
    "provider_id": "glm-anthropic",
    "protocol_strategy": "passthrough_only",
    "base_url": "https://open.bigmodel.cn",
    "provider_profile": "glm_coding",
    "logical_models": ["glm-4.5"],
    "upstream_model": "glm-4.5",
    "capabilities": ["chat"],
    "priority": 100,
    "weight": 100,
    "status": "active"
  },
  {
    "client_protocol": "openai",
    "provider_id": "glm-openai",
    "protocol_strategy": "passthrough_only",
    "base_url": "https://open.bigmodel.cn",
    "provider_profile": "glm_coding",
    "logical_models": ["glm-4.5"],
    "upstream_model": "glm-4.5",
    "capabilities": ["chat"],
    "priority": 100,
    "weight": 100,
    "status": "active"
  }
]'::jsonb
WHERE "code" IN ('zhipu_overseas', 'zhipu_cn')
  AND "dedicated_endpoints" IS NULL;
