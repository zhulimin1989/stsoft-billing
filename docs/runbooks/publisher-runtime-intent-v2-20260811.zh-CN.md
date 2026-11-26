# Publisher RuntimeIntent v2 上线手册（2026-08-11）

## 目标与边界

本次变更把 Billing 的 Publisher 写契约从 RuntimeIntent v1 升级到 v2，并为平台 Channel 与 CodingPlan 专属上游凭据提供稳定的 `provider_account_ref`。账户身份与密钥分离：轮换密钥只改变凭据，不改变账户身份。

以下行为明确禁止：

- 不从 API Key、密文、`key_id`、Channel ID 或 Entitlement ID 推导 `provider_account_ref`。
- 不在 Publisher 增加 v1 自动兼容或临时合成身份。
- 不重试旧 v1 请求体，也不复用旧 v1 幂等键。
- 不把嵌套 `route_graph.schema_version` 改为 2；该组件仍为 v1。

## 阶段 A：部署同一制品并完成数据准备

1. 进入短维护窗口，先停止所有会改变 Publisher 状态的入口：Channel/Provider Line/Product Route/模型与产品配置、API Key 创建/轮换/禁用/删除、provider-resale 下单与履约，以及会产生 KeyBalance 变化的 UAT 流量。等待当前可完成的 Publisher 任务与 outbox 排空，并记录尚未完成的旧协议任务。

   维护窗口中只允许账户身份创建/绑定、本手册的回填和 readiness 操作。这个停写约束是必需的：迁移模式不会创建同步任务，而全量重放也不能从已删除的本地记录反推 tombstone。
2. 先执行 `prisma migrate deploy`，并确认以下两条迁移已按顺序 applied：

   - `20260811000100_provider_account_identities`
   - `20260811000200_provider_entitlement_fulfillment_claim`

   第一条新增账户身份和可空外键，第二条新增履约 attempt claim/lease 字段；最终 Billing 制品依赖二者，不能只部署第一条。维护窗口已停止旧履约入口，因此第一条迁移对 ACTIVE entitlement 的最终约束不会与旧 writer 竞态。
3. 使用最终将上线的同一 Billing/Admin 制品进入受控迁移模式；不要先启动 v2 writer：

```bash
PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE=true
PUBLISHER_ENABLED=false
PUBLISHER_SYNC_WORKER_ENABLED=false
```

任何环境只要 `PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE=true`，就必须同时精确设置后两项为 `false`，否则 Billing 拒绝启动。该模式不启动 Publisher retry worker/scheduler，Publisher client 也不会发起网络请求；不可把它作为长期运行配置。
4. 在 Admin 的 Channels 页面创建供应商账户身份。一个真实上游账户只创建一个身份；同一账户的多个 Channel 复用它。
5. 给所有参与 RuntimeIntent 的 Channel 绑定身份。身份的 provider 必须与 Channel provider 一致。
6. 在迁移模式下，CodingPlan Provider Line 和存量 entitlement 的身份绑定统一使用下面的显式 backfill，不通过 Provider Line 管理 API/UI 保存。该管理写入口会在数据库提交后执行 required publish；此时 Publisher 被有意关闭，因此会返回下发失败，容易让操作员误判数据库是否已经写入。正常模式恢复后，Provider Line 管理 API/UI 可照常使用。新 entitlement 会从 Provider Line 原子继承身份；如环境存在有效的 CodingPlan provider-resale 凭据，必须在同一映射中同时完成 Provider Line 和存量 entitlement 绑定。映射文件只引用已经创建的身份：

```json
{
  "channels": [
    {
      "id": "<channel-id>",
      "providerAccountRef": "<server-generated-provider-account-ref>"
    }
  ],
  "codingPlanProviderLines": [
    {
      "id": "<provider-line-id>",
      "providerAccountRef": "<server-generated-provider-account-ref>"
    }
  ],
  "codingPlanProviderEntitlements": [
    {
      "id": "<provider-entitlement-id>",
      "providerAccountRef": "<server-generated-provider-account-ref>"
    }
  ]
}
```

先 dry-run，再显式执行；脚本以单事务写入，拒绝覆盖已经绑定到其他身份的记录：

```bash
export BILLING_DATABASE_URL='<billing-database-url>'
pnpm provider-accounts:backfill --mapping=/absolute/path/provider-account-mapping.json
pnpm provider-accounts:backfill --mapping=/absolute/path/provider-account-mapping.json --apply
```

写脚本只接受 `BILLING_DATABASE_URL`，不会回退到通用 `DATABASE_URL`。

7. 执行只读 readiness。它会用生产 RuntimeIntent builder 做本地构造与合同校验，检查所有 `fulfillmentEnabled` Provider Line，并扫描所有仍有效的 CodingPlan provider entitlement（包括上游凭据只缺一侧的异常记录）；专用 composition 不加载 Publisher worker、scheduler、bootstrap 或 Redis，不会请求 Publisher，也不会输出密钥。readiness 同样强制使用上文显式设置的 `BILLING_DATABASE_URL`，不会回退到 `DATABASE_URL`：

```bash
pnpm publisher:account-readiness
```

只有报告中的 `ready=true` 才能进入阶段 B。新建 CodingPlan provider-resale entitlement 会在调用上游前验证 Provider Line 身份，先持久化一条精确继承该身份的 `PENDING` 预留记录，再调用上游并转为 `ACTIVE`；流程不会从上游 Key、订单号或 Entitlement ID 自动推导账户身份。

## 阶段 B：启用 v2 writer 并验证

1. readiness 通过后，用同一制品切换为正常生产配置并滚动重启 Billing：

```bash
PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE=false
PUBLISHER_ENABLED=true
PUBLISHER_SYNC_WORKER_ENABLED=true
```

确认所有 Billing 实例都退出迁移模式后，才发起 fresh replay；此时仍不要解除维护窗口的停写。
2. 观察 Publisher 同步任务。以下遗留请求会转为终态，不会重放旧 body：

   - `RUNTIME_INTENT_V1_RETIRED`
   - `LEGACY_KEY_POOL_PUBLISH_RETIRED`
   - `DEDICATED_KEY_META_V1_RETIRED`
   - `LEGACY_PROVIDER_PUBLISH_RETIRED`
3. 从 Billing 当前 source of truth 发起一次 `scope=all` 的 fresh replay（可从 Admin 的 Publisher 同步任务页操作，或调用 Billing 内部管理接口）：

```http
POST /api/internal/billing/admin/publisher-sync-jobs/replay
Content-Type: application/json

{"scope":"all"}
```

这个全量重放使用新的 `replayRunId`/幂等键，分页遍历 Billing 保留的全部 API Key 记录（包括软删除/已撤销记录）和对应 KeyBalance，会为历史删除状态重放 revoke/delete tombstone，不存在 5000 条截断，也不会在 `scope=all` 中重复下发 KeyBalance；同时重建 PlatformConfig、RuntimeIntent 和 Admin topology。核对响应中 `apiKeys`、`keyBalances` 均等于 Billing 保留的 API Key 总数，`productRuntimePolicies` 与当前 source of truth 一致，且 `platformConfig=true`、`adminTopology=true`。

全量 replay 在返回前会逐项投递同步任务。执行前应临时提高该内部管理请求的代理超时，并指定单一操作人、只允许一个请求在途。不要因管理代理超时立即重复发起；先检查 Billing 日志和 `rd:replay:*` 同步任务是否仍在持续增加，确认首次调用已停止后再重试，避免两个 `replayRunId` 重叠执行。
4. 等待本次 `replayRunId` 生成的 Publisher 同步任务全部进入成功或明确终态，再核对 Publisher batch/outbox 已完成。任一步失败时保持停写，修正 source of truth 后重新发起一次全量 replay；不修改旧任务 body。
5. 在 Gateway 检查目标 Kimi credential 的版本或密文摘要已经变化、`provider_account_ref` 保持不变。对存在 provider-resale 的环境，确认 `dedicated_upstream.provider_account_ref` 存在且 KeyMeta 生效。
6. 如需单独验证 RuntimeIntent 合同，可在全量 replay 后执行下列命令作为 smoke test；它不能代替第 3 步的全量重放：

```bash
pnpm publisher:intent-it --mode=post-valid --source=db
```

7. 只有全量 replay、outbox 与 Gateway 核对全部完成后，才恢复第 A.1 步暂停的控制面写入、履约和 UAT 流量。

仅看到 HTTP 202 不代表 Gateway 已经生效；必须完成 outbox 与 Gateway 状态核对。

## 失败处理

- readiness 报身份缺失、停用或 provider 不匹配：修正控制面绑定后重跑；不要绕过校验。
- Publisher 返回 400/422：保留失败任务和请求证据，修正 source of truth 后发起 fresh replay；不要手工修改旧任务 body。
- Publisher 或 Gateway 暂时不可用：v2 任务可按现有重试策略恢复；v1 任务不可恢复，只能从当前状态重建。
- 如需回退 Billing 应用版本，必须继续保持 Publisher 写入和 provider-resale 履约停写。迁移 `20260811000100_provider_account_identities` 的数据库约束要求新建 ACTIVE Provider Entitlement 携带并继承账户身份，旧 Billing writer 不满足该约束，不能在回退后恢复履约。数据库新增表和可空列可以保留；业务只能在重新前滚到 v2 writer，或完成经验证、全链路协调的数据库回退后恢复。不得将 v1 writer 与只接受 v2 的 Publisher 混跑。
