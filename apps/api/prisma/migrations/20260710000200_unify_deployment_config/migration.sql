ALTER TABLE "system_configs"
  ADD COLUMN IF NOT EXISTS "version" BIGINT NOT NULL DEFAULT 0;

WITH legacy AS (
  SELECT
    COALESCE(MAX(CASE WHEN "key" = 'platformConfig' THEN "value" END)::jsonb, '{}'::jsonb) AS platform,
    COALESCE(MAX(CASE WHEN "key" = 'authConfig' THEN "value" END)::jsonb, '{}'::jsonb) AS auth
  FROM "system_configs"
), normalized AS (
  SELECT
    CASE
      WHEN lower(COALESCE(platform->>'region', '')) IN ('domestic', 'cn', 'china') THEN 'domestic'
      WHEN lower(COALESCE(platform->>'region', '')) IN ('overseas', 'global', 'intl', 'international') THEN 'overseas'
      WHEN lower(COALESCE(auth->>'provider', '')) = 'authing' THEN 'domestic'
      WHEN lower(COALESCE(auth->>'provider', '')) = 'auth0' THEN 'overseas'
      ELSE NULL
    END AS region,
    platform
  FROM legacy
)
INSERT INTO "system_configs" (
  "id", "key", "value", "version", "description", "created_at", "updated_at"
)
SELECT
  'deployment-config',
  'deploymentConfig',
  jsonb_build_object(
    'region', region,
    'currency', lower(COALESCE(NULLIF(platform->>'currency', ''), CASE WHEN region = 'domestic' THEN 'cny' ELSE 'usd' END)),
    'defaultLanguage', lower(COALESCE(NULLIF(platform->>'defaultLanguage', ''), CASE WHEN region = 'domestic' THEN 'zh' ELSE 'en' END)),
    'oauth', '{}'::jsonb
  )::text,
  -- Downstream starts at v0 so Admin's first authoritative v1 snapshot always wins.
  0,
  '统一部署运行时配置；provider 由 region 派生',
  NOW(),
  NOW()
FROM normalized
WHERE region IS NOT NULL
ON CONFLICT ("key") DO NOTHING;
