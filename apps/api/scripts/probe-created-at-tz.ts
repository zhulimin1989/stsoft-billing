import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const ACCOUNT = '6ad5ab22-add8-48d4-87f8-295781d4ca8d';

async function main() {
  const rows = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      tu.created_at::text AS wall_text,
      tu.created_at AS wall_js,
      current_setting('TIMEZONE') AS session_tz,
      now()::text AS db_now_text,
      (NOW() AT TIME ZONE 'UTC')::text AS utc_now_wall,
      (NOW() AT TIME ZONE 'Asia/Shanghai')::text AS sh_now_wall
    FROM token_usage tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE t.billing_account_id = $1
      AND tu.created_at >= TIMESTAMP '2026-09-30 15:59:00'
      AND tu.created_at < TIMESTAMP '2026-10-01 00:01:00'
    ORDER BY tu.created_at
    LIMIT 8
  `, ACCOUNT);

  // Cross-check with gateway first_received_at / occurred_at if linked
  const joined = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      tu.created_at::text AS usage_wall,
      gbe.created_at::text AS event_wall,
      gusa.occurred_at::text AS anchor_occurred,
      gusa.first_received_at::text AS anchor_first_received,
      pg_typeof(tu.created_at)::text AS usage_type,
      pg_typeof(gusa.occurred_at)::text AS occurred_type
    FROM token_usage tu
    JOIN tenants t ON t.id = tu.tenant_id
    LEFT JOIN gateway_billing_events gbe ON gbe.id = tu.gateway_billing_event_id
    LEFT JOIN gateway_usage_settlement_anchors gusa ON gusa.gateway_billing_event_id = tu.gateway_billing_event_id
    WHERE t.billing_account_id = $1
      AND tu.created_at >= TIMESTAMP '2026-09-30 16:00:00'
      AND tu.created_at < TIMESTAMP '2026-09-30 16:05:00'
    ORDER BY tu.created_at
    LIMIT 5
  `, ACCOUNT);

  console.log(JSON.stringify({ boundaryRows: rows, linked: joined }, null, 2));
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
