# Billing API Reference

更新时间: 2026-08-11

本文档覆盖 billing 服务当前对外、对内和对 Publisher 的接口边界。Publisher 部分参考 `/Users/shineli/Desktop/2026-05-13-publisher-api-reference.md`，不修改发布方文档。

多产品用户管理上线后，`tenant_id` 的含义是账号 / workspace id，不再兼容 userId。Publisher/Gateway 联动变更见 [Publisher / Gateway Tenant Contract Change](./publisher-gateway-tenant-contract-change.md)。

## 1. 服务边界

Billing 是计费、余额、积分、订阅、订单、支付实例、用量计价策略的唯一执行方。调用方按安全域拆分:

| 调用方 | API 前缀 | 用途 |
| --- | --- | --- |
| user 前端 | user-server `/api/billing/*`, `/api/payment/*` | 用户查看套餐、余额、账单、下单、查订单；user-server 仅做 facade，实际请求转发到 billing |
| gateway | Kafka `gateway.usage_events` topic | UsageEvent v2 入账、最终扣费 |
| admin | `/api/internal/billing/admin/*` | 运营管理产品、套餐、订单、余额、积分、策略、支付配置 |
| payment provider | `/api/payment/notify/*` | 微信、支付宝、Stripe 异步通知 |
| Publisher | 由 billing/admin 主动调用 `/billing/api/v1/key-balance/*` | 给转发平面同步 key 是否仍有额度 |

所有 JSON API 默认响应:

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

## 2. 通用安全约定

- 用户侧接口使用登录态鉴权；公开接口只限套餐、产品、加量包列表和支付回调。生产链路中 user-server 只代理到内网 billing，不直接读写 billing 数据库。
- internal billing API 使用调用方专属 `x-internal-caller`、`x-internal-token` 和 `x-billing-api-version`。`admin-api` 使用 `ADMIN_TO_BILLING_TOKEN` 并附带签名 admin context；`user-api` 使用 `USER_TO_BILLING_TOKEN` 且只允许显式白名单路由。
- internal API 生产环境只允许内网、VPC、专线、VPN、service mesh 或私有 LB 访问。
- 如果跨公网传输，必须使用 HTTPS，并建议叠加 mTLS、IP allowlist 或服务网格身份校验。
- Gateway UsageEvent v2 必须携带稳定 `request_id`；同一次网关调用的事件投递、Kafka 重投和 replay 必须复用该 ID。客户端发起新的 HTTP 重试属于新的网关调用，可以产生新的内部 `request_id`。
- gateway 生产计费入口默认走 Kafka `gateway.usage_events` topic；billing ledger 只订阅 `UsageEvent` v2。`RequestEvent` 只用于审计、诊断、风控和客服排障，不能驱动扣费。
- 支付回调必须使用原始 body 验签；微信、支付宝按通知 ID 做重放保护，Stripe 按签名头验签。
- 不在 Publisher、日志或文档中传明文上游 key。Publisher key-pool 默认下发 gateway 合约格式：本地模式为 `enc:local:<base64(nonce|ciphertext|tag)>`，AWS KMS 模式为 `enc:<base64(CiphertextBlob)>`；确需本地调试才可显式打开 `PUBLISHER_ALLOW_PLAINTEXT_UPSTREAM_KEYS=true`，生产环境会忽略该开关。

## 3. 用户 Billing API

Base URL: `USER_API_URL/api/billing`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/plans?productId=` | 公开 | 查询订阅套餐 |
| `GET` | `/products` | 公开 | 查询启用产品 |
| `GET` | `/bundles` | 公开 | 查询组合套餐 |
| `GET` | `/booster-packs?productId=` | 公开 | 查询加量包 |
| `GET` | `/balance` | 用户 | 查询余额，返回 `balanceCents`, `balanceUsd` |
| `GET` | `/current-subscription?productId=` | 用户 | 查询当前有效订阅 |
| `GET` | `/credits-summary` | 用户 | 查询积分摘要 |
| `GET` | `/credits?productId=` | 用户 | 查询双池积分余额 |
| `GET` | `/transactions?page=&pageSize=&productId=` | 用户 | 查询余额流水 |
| `GET` | `/credit-transactions?page=&pageSize=&productId=` | 用户 | 查询积分流水 |
| `GET` | `/daily-summary?startDate=&endDate=&apiKeyId=` | 用户 | 查询日账单汇总，可按 API Key 过滤 |
| `GET` | `/monthly-summary?year=` | 用户 | 查询月账单汇总 |
| `GET` | `/export?type=&startDate=&endDate=&year=` | 用户 | 导出 CSV，`type=daily/monthly/transactions` |

## 4. 用户 Payment API

Base URL: `USER_API_URL/api/payment`

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/create` | 用户 | 创建订单 |
| `GET` | `/orders` | 用户 | 查询当前用户订单 |
| `GET` | `/orders/:id` | 用户 | 查询订单详情 |
| `GET` | `/orders/:id/status` | 用户 | 轻量轮询支付状态 |
| `POST` | `/orders/:id/cancel` | 用户 | 取消未支付订单 |
| `POST` | `/notify/wechat` | 公开回调 | 微信支付 V3 通知，验签、解密、重放保护 |
| `POST` | `/notify/alipay` | 公开回调 | 支付宝 form 回调，验签、重放保护 |
| `POST` | `/notify/stripe` | 公开回调 | Stripe webhook，使用 `stripe-signature` 验签 |

`POST /create` 使用 `createOrderSchema`，常见字段包括 `orderType`、`planId`、`bundleId`、`boosterPackId`、`channel`、`currency`、`successUrl`、`cancelUrl`。Stripe 下单如果前端未传回跳地址，后端会基于 `origin`、`referer` 或 `x-forwarded-*` 自动补齐。

## 5. Gateway Usage Ingestion

生产唯一入口: Kafka `gateway.usage_events` topic。HTTP usage fallback 已废弃；billing runtime 不再暴露 `/api/internal/billing/usage/*`。

### 5.1 事件流程

Gateway 有 token fact 时必须产生 `UsageEvent` v2，并写入 Kafka `gateway.usage_events`。Billing ledger 只消费 `UsageEvent` v2；`RequestEvent` 可以由单独 consumer 入库到 audit/request trace 表，但不得进入扣费链路。Kafka 故障恢复依赖 gateway 侧 outbox/replay 与 billing consumer 幂等处理，不支持同步 HTTP 改道扣费。

```mermaid
sequenceDiagram
  participant Client
  participant Gateway
  participant Billing
  participant Publisher
  participant Upstream

  Client->>Gateway: OpenAI-compatible request with API Key
  Gateway->>Upstream: forward request
  Upstream-->>Gateway: response + usage / error
  Gateway->>Billing: Kafka gateway.usage_events with UsageEvent v2
  Billing->>Billing: validate usage/v2 and freeze the first-receipt settlement anchor
  Billing->>Billing: derive v3 customer authority (exact / protective zero)
  Billing->>Billing: settle or release funding; keep incomplete provider evidence OPEN internally
  Billing-->>Publisher: PUT /billing/api/v1/key-balance/{key_id}
  Gateway-->>Client: final response
```

Kafka consumer 配置:

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BILLING_USAGE_KAFKA_ENABLED` | `false` | 设为 `true` 后 billing 启动 Kafka consumer；生产必须为 `true`，否则启动 fail-fast |
| `BILLING_USAGE_KAFKA_BROKERS` | 空 | MSK `bootstrapBrokerStringVpcConnectivitySaslScram`，逗号分隔 |
| `BILLING_USAGE_KAFKA_TOPICS` | `gateway.usage_events` | 订阅 topic，生产建议只订 gateway UsageEvent v2 |
| `BILLING_USAGE_KAFKA_GROUP_ID` | `billing-ledger-v1` | billing 独立 consumer group，不与其他服务共用 |
| `BILLING_USAGE_KAFKA_CLIENT_ID` | `ruidong-billing` | Kafka client id |
| `BILLING_USAGE_KAFKA_CONCURRENCY` | `3` | 分区并发消费数 |
| `BILLING_USAGE_KAFKA_SECURITY_PROTOCOL` | `SASL_SSL` | MSK multi-VPC private connectivity 要求使用 `SASL_SSL` |
| `BILLING_USAGE_KAFKA_SSL` | `true` | Kafka TLS，生产不要关闭 |
| `BILLING_USAGE_KAFKA_USERNAME` / `BILLING_USAGE_KAFKA_PASSWORD` | 空 | MSK SCRAM 凭据，由部署系统或 Secret Manager 注入 |
| `BILLING_USAGE_KAFKA_SASL_MECHANISM` | `scram-sha-512` | 对应 MSK `SCRAM-SHA-512` |
| `BILLING_USAGE_KAFKA_HMAC_MODE` | 生产必须显式设置；其它环境 `off` | Kafka transport 独立鉴权模式：`off` / `shadow` / `required`。生产缺失或设为 `off` 都会启动失败；首次迁移必须显式用 `shadow` 观测，稳定态使用 `required`；不得复用 `BILLING_USAGE_EVIDENCE_CONTRACT_MODE` |
| `BILLING_USAGE_KAFKA_HMAC_KEY_ID` | 空 | 与单 key secret 配对的规范 `kid`，必须匹配 `^[A-Za-z0-9._-]{1,64}$` |
| `BILLING_USAGE_KAFKA_HMAC_SECRET` | 空 | 与 `BILLING_USAGE_KAFKA_HMAC_KEY_ID` 配对的精确 UTF-8 secret；禁止首尾空白，长度 32-4096 字节 |
| `BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON` | 空 | 可选的 `{ "kid": "secret" }` JSON object，用于多区或双 key 轮换；与单 key 配置合并后最多 16 把，进程启动时一次性加载，不逐消息访问外部 secret 服务 |
| `BILLING_USAGE_KAFKA_DLQ_TOPIC` | 空 | 生产必须配置；处理失败耗尽重试后写入 DLQ |
| `BILLING_USAGE_KAFKA_CONNECTION_TIMEOUT_MS` | `10000` | Kafka 连接超时 |
| `BILLING_USAGE_KAFKA_REQUEST_TIMEOUT_MS` | `30000` | Kafka 请求超时 |
| `BILLING_USAGE_KAFKA_RETRIES` | `3` | Kafka 客户端重试次数 |
| `BILLING_USAGE_EVIDENCE_CONTRACT_MODE` | `shadow` | Provider evidence 的内部审计模式，合法值为 `shadow` / `enforce`。生产仍应显式配置；缺失、非法或与数据库 rollout mode 漂移时记录低基数告警并按安全 `shadow` 语义继续客户结算，不阻断 Kafka consumer |
| `BILLING_USAGE_VERIFIED_PRODUCER_BUILDS` | 空 | 逗号分隔的可信 Gateway `producer_build_sha`；完整 SHA 用于 provider evidence 审计及应用层 `NO_CHARGE` 合法性判断。空值、非法/重复值或与数据库 authority 集合漂移时记录内部告警，不作为客户财务终态或 consumer 启动硬闸 |
| `BILLING_ALLOW_DEFAULT_PAYG_FALLBACK` | `false` | 生产必须保持 `false`；API Key 未绑定产品时直接拒绝，不自动归到 PAYG |
| `BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE` | `false` | 必须保持 `false`。Gateway 事件映射不会用部署开关创建额外信用：企业仅使用有效账户授信，无有效授信时按个人余额政策处理 |
| `BILLING_USAGE_PENDING_MAX_REQUESTS` | 生产示例 `100` | 账户级未完成资金请求硬上限；生产必须为正整数。统一统计 `ACTIVE/MANUAL_REVIEW` funding reservation 与经完整性校验的首次收件 provisional guard（包括健康的 `funding_reservation_queue_pending`）。计数达到阈值即关闸；存在未完成资金请求时配置缺失或非法也按风险超限处理。provider evidence `OPEN` 不计入 |
| `BILLING_USAGE_PENDING_MAX_EXPOSURE_USD` | 生产示例 `1000` | 可选的账户级未完成资金敞口硬上限；统一累计上述 reservation 与 provisional guard 的冻结金额，达到阈值即关闸。数值按 `BILLING_PLATFORM_CURRENCY` 解释（国内为 CNY，字段名保留兼容命名）；未配置或配置为 `0` 时不启用金额阈值。provider evidence `OPEN` 不产生客户 pending exposure 或 restriction |

Kafka HMAC v1 contract:

- Gateway 必须发送且各仅发送一个规范小写 header：`x-billing-key-id`、`x-billing-timestamp`、`x-billing-signature`。重复 header、大小写冲突、未知 `kid`、非规范正十进制 Unix 秒、非 64 位小写 hex signature 均为认证失败。
- Billing 对 Kafka `message.value` 原始字节计算 SHA-256；不得先解码、解析或重新序列化 JSON。签名输入是以下四行，最后无换行：

  ```text
  gateway-usage-hmac-v1
  <kid>
  <unix-seconds>
  <sha256hex(exact message.value bytes)>
  ```

- signature 是上述 UTF-8 signing input 的 `hex(HMAC-SHA256(secret, signingInput))`。Kafka 是持久日志，Billing 只校验 timestamp 的规范格式，不应用 webhook 的历史 freshness 窗口；财务重放由数据库 `request_id` / evidence inbox / 永久 receipt 防护。
- 跨仓固定向量：secret=`0123456789abcdef0123456789abcdef`，kid=`usage-test-a`，timestamp=`1786752000`，body exact=`{"event_type":"usage","request_id":"req-hmac-vector-1","version":"v2"}`，payload SHA-256=`df8a02852521ba2e5009aae6deb8e90bbecd4cfae5f6498860d1c3b13d90c913`，signature=`5722ba1a1cc13bb3d5935316dcf73aaff09ab953e8d689befc7ebcfb98c9a851`。
- 普通轮换先让 Billing keyring 同时接受 A/B，确认全体 consumer 就绪后 Gateway 才切 B；待旧 key 对应 partition 高水位全部消费后移除 A。密钥泄露走立即撤销，不使用轮换宽限。

Consumer 运行语义:

- billing 显式设置 `autoCommit=false`，不会在拉到消息后自动提交 offset。
- consumer 启动时会拒绝 `request_event` / `gateway.request_events` 这类 RequestEvent topic；这些 topic 只能由审计链路消费。
- `shadow` 对每条消息记录固定低基数 HMAC outcome 后继续现有账务路径；指标 `ruidong_billing_usage_kafka_hmac_verifications_total` 只有 `mode/outcome` 标签，禁止把外部 `kid` 放入 metric label。
- `required` 认证失败不会调用 `GatewayRequestEventBillingService.process()`，也不进入普通三次消息重试；只尝试一次 DLQ。DLQ broker 未确认时源 offset 不得提交。
- `GatewayRequestEventBillingService.process()` 返回成功后，billing 才提交 `topic/partition/offset+1`。
- 处理失败、入账失败、解析失败时不提交 offset，Kafka 会重新投递。只有源事件已入账，或 DLQ 已得到 broker 确认后，才能提交源 offset；DLQ 写失败不得提交。
- 本地入账使用 `request_id` / `gateway:request:{request_id}` 做幂等，允许重复投递但不能重复扣费。

Billing 处理规则:

- 只有 `event_type="usage"` 且 `version="v2"` 的事件可计费；`event_type="request_event"` 会被跳过且不写入扣费审计表。
- 使用 `key_id` 作为 `apiKeyId`，它必须等于 admin 本地 `ApiKey.id`；无 API Key 的内部主体必须提供可校验的 `tenant_id`、`user_id` 或 `labels.email`。
- 优先使用 `upstream_model` 作为计费模型，其次兼容 `actual_model`、`resolved_model`、`model`。
- `prompt_tokens` 是 Gateway 归一化后的总输入（gross input），不是 Anthropic 上游原始的 fresh `input_tokens`。Billing 将 `token_extras.cached_tokens/cache_read_input_tokens` 和 `token_extras.cache_creation_input_tokens/cache_write_tokens` 分别映射为 cache read/write，并按 `regular input = prompt_tokens - cache read - cache write` 拆分计价；因此必须满足 `cache read + cache write <= prompt_tokens`。Anthropic 原始用量由 Gateway 归一化为 `prompt_tokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；`completion_tokens` 映射为输出 token。
- 幂等键固定为 `gateway:request:{request_id}`，同一请求重试不会重复扣费。
- `status=success/failure`、`is_idempotent_replay`、quota/error 标签本身都不是客户扣费授权。只有满足应用层永久 `NO_CHARGE` 合法性证明的事件可以直接释放资金；其它不确定事件进入下述客户保护结算，而不是长期 `SKIPPED` 或 evidence hold。
- 新的客户用量结算使用 `gateway-settlement-v3-customer-authority` 永久 receipt；合法 `NO_CHARGE` 继续使用独立的永久不收费证明。`customerFinancialAuthority` 绑定首次 settlement anchor、冻结客户价格、原始/结算六维用量以及两种互斥 basis：`NORMALIZED_EXACT`、`CUSTOMER_PROTECTIVE_ZERO`。历史已提交的 v2 receipt 作为不可变财务事实继续幂等重放，但不会用于新结算。
- `NORMALIZED_EXACT` 只在标准化数值语义和整数/总数/cache 不变量可证明时按首次冻结 quote 结算，其中 `total_tokens = prompt_tokens + completion_tokens`，且 `cache read + cache write <= prompt_tokens`。缺 build SHA、provider account、upstream ID、provider usage hash 等纯审计字段不会改变客户金额。
- customer settlement v2 将上游未回传的 cache read/write 数量视为 0；若事件提供显式非负整数，则在总数和 cache 分桶不变量成立时保留该数值，即使 `dimensions_present` 漏标该 cache 维度也不清零核心用量。cache read/write 客户单价独立冻结在首次 anchor 中，不能因为本次对应数量为 0 就冻结为 `null`。cache 缺失或 presence 漏标仍可保留 provider evidence `INCOMPLETE/OPEN`，但其本身不改变客户金额，也不创建账户 restriction。
- 其它会影响金额可信度的数值/来源不确定（例如核心 input/output 维度缺失或非整数、负数、`total_tokens` 不一致、cache 分桶之和超过 `prompt_tokens`、缺少/未知 token source、非政策 `estimated`、无法证明的零用量或 output-required input-only）统一使用 `CUSTOMER_PROTECTIVE_ZERO`：本次客户 token/image 六维和 USD/积分金额全部置 0，平台承担不确定部分；原始 Gateway 维度、provider cost 和 raw evidence 仍保留在内部记录中。除仅由 cache 未回传造成的 `partial` 外，`usage_evidence.status/source/protocol/terminal_frame_seen` 不完整也属于金额可信度不确定并走保护零；政策允许的 `estimated_tokenizer` 仍可按规范化数值结算。
- `producer_build_sha`、`provider_usage_hash`、`provider_account_ref`、upstream correlation、`provider_reconciliation_required` 及 rollout/build drift 是 provider audit/reconciliation 字段，缺失或保持 `INCOMPLETE/OPEN` 不会改变已证明的 `NORMALIZED_EXACT` 金额。无论这些纯审计缺陷，还是已触发保护零的 status/protocol 不确定，系统都保留 append-only evidence、内部 conflict action 和告警；不得因 evidence 审计额外产生客户 pending exposure、可用余额扣减、`evidence_conflict` restriction 或长期资金 hold，也不得阻断已选 v3 customer authority 的正常财务终态。
- Provider evidence 问题本身不再产生 `QUARANTINED`。只有无法形成/验证首次 anchor、funding reservation、ledger/receipt 幂等证明等真实财务冲突才会进入财务隔离或可重试状态；真实余额/积分不足仍写 `DEBT_OPEN` 并保留债务 restriction。
- 无论 exact 还是 protective zero，客户财务终态都通过 Usage 层原子写入 `TokenUsage`、v3 永久 receipt 和资金结果。BALANCE reservation 按权威金额消费/释放；CREDITS 零价、included 或 protective zero 不伪造积分 mutation。完成后强制刷新 Publisher 投影，不再聚合 legacy evidence `OPEN` 为客户 pending。
- BALANCE 首次收件先持久化首次 anchor、冻结金额和 `pending_usage_unreserved` guard。Publisher 只把与 event/anchor/账户/Key/币种/冻结 quote 完整匹配且尚无 reservation 的 guard 解释为等额 provisional hold，从可用余额中扣除，而不是把健康在途请求直接变成账户级 `billing_review`；任何结构不一致、重复 guard 或 guard/reservation 并存都保持 fail-closed。
- 账户顺序轮到该请求后，reservation 事务冻结非过期 grant slice 和当时可用授信，并在同一数据库事务中释放 provisional guard。Publisher 用单条 PostgreSQL snapshot 查询完成 guard→reservation 分类，交接前只计 guard、交接后只计 reservation，不会漏计或双计。
- `funding_reservation_queue_pending` 表示等待更早的不可变首次收件完成资金预占，是正常的账户 FIFO 串行化状态。它保留冻结金额和 provisional guard，但不创建 `settlement_retry_pending`，因此结构有效且未触及请求数/敞口阈值时不会单独造成账户级 `billing_review`；其它结算重试、结构异常或阈值超限仍然关闸。
- PostgreSQL 延迟约束验证 v3 typed authority、TokenUsage、receipt、ledger/allocation 与 reservation 数学一致性；持久化 provider evidence 的 HMAC/hash、首次 anchor 和幂等键任一被篡改都会使事务回滚，但 provider build 的可变 current-authority 状态不是客户财务终态证明。Kafka transport HMAC 则由 consumer 在 JSON 解析和数据库事务之前验证，不属于该数据库约束。
- `NO_CHARGE` 仍是严格的资金释放动作：应用运行时只在 quota rollback 或完整 provider-terminal zero 同时满足当前 verified-build 合法性时选择它。若该运行时证明不足，系统走可持久重放的 protective-zero receipt 并同样及时释放 reservation。数据库继续验证 evidence hash、anchor、receipt、ledger/funding 数学证明，但不再要求 producer build 在提交时仍是 mutable current tail，也不因 evidence rollout mode 的 `SHADOW/ENFORCE` 差异拒绝合法财务终态。
- 每条事件都会写入 `gateway_billing_events`，原始 `raw_event` 不可覆盖；后续证据追加到 `gateway_usage_evidences`。状态包括 `RECEIVED`、`QUARANTINED`、`DEDUCTED`、`DEBT_OPEN`、`ABSORBED`、`SKIPPED` 和失败状态。
- 权威用量按单笔钱包前后值拆为 `collected / approvedCredit / unapprovedDebt`。企业有效额度内的负余额写 `RECEIVABLE`，冻结请求发生时账期和到期日；超过额度的部分写 `DEBT_OPEN` 并立即限制账户。企业未开通信用、额度为 0 或信用非 ACTIVE 时，全部超额都按个人账户的未批准欠款处理，不获得企业账期。
- 延迟结算的企业事件在当前授信配置为 `ACTIVE` 时，只使用请求发生时可证明的授信额度、状态、生效/失效窗口和账期；不能把结算前后来开通的授信倒借给旧请求。发生时策略历史无法完整重建时必须在任何钱包、额度或 TokenUsage 写入前进入可重试失败，等待策略边界恢复。当前配置不存在或为 `DISABLED` / `SUSPENDED` 时，企业明确走与个人账户一致的零信用预付费路径，不查询授信历史；授信金额恒为 0、无账期，足额预付资金按不可变 Grant slice 预占。
- `token_usage.customer_charge_usd` 始终保存客户总费用，并分别记录实收、企业信用应收和未批准欠款，三项在新事件上必须严格等于总费用，避免部分付款请求在收入/应收报表中整条归零。
- API Key、主体投影、订阅、模型授权或定价等可修复配置暂缺时，事件进入 `RETRYABLE_FAILED + RETRY_WAIT` 并持久关停对应账务主体；配置修复后只能经幂等技术重试结算。上述健康的 `funding_reservation_queue_pending` 是唯一不创建重试硬 restriction 的 FIFO 等待状态。已交付但返回未知政策拒绝、`user_required` 等不能自动扣款的情况进入 `QUARANTINED + MANUAL_REVIEW`，不得写普通 `FAILED+CLOSED`。
- JSON 合同进入业务处理后，无法校验 request id、计费主体、首次 anchor 或持久化 evidence 完整性等不可修复的财务事件缺陷，如果仍能识别 API Key，则进入 `MANUAL_REVIEW` 并 fail-closed；这不包括纯 provider evidence 审计字段。`required` 模式下 Kafka transport HMAC 失败发生在 JSON 解析前，不调用账务 `process`，只尝试一次 DLQ；只有 DLQ 获得 broker 确认后才提交源 offset。
- 经财务审批将待核验请求标记为 `ABSORBED` 时，客户扣款恒为 0，系统写永久 receipt，并释放该事件产生的 `pending_usage_unreserved`、`settlement_policy_review` 及旧版本遗留的 `evidence_conflict` restriction；账户级其它未关闭风险仍会继续关闸。对于已经结算后才收到权威修正证据的请求，使用独立 `absorb-delta` 动作，按首次冻结费率追加客户少计差额、供应商成本差额和平台损失，不修改原 TokenUsage、客户余额、原账单或原回执。
- 本次 additive migration 不会从历史 JSON 猜测权威证据或资金结果：存量事件保持 `UNKNOWN/OPEN`，不伪造 evidence、`COLLECTED` 结果或 settlement receipt。历史修复必须独立 dry-run、审批并按批次执行。
- 自动断连补扣仍为 NO-GO。只有逐请求供应商权威证据链打通后，才能另行启用 correction worker；当前管理端只允许技术故障重试、转人工复核和经财务审批的平台吸收，禁止按估算 Token 自动补扣。

### 5.2 Additive evidence contract 生产发布顺序

这次数据库变更是 additive migration，但新旧 Billing 二进制不能在迁移后并行消费同一个账务 topic。Billing 不做 Pod 百分比金丝雀，也不能让旧 consumer 与新 consumer 在 rolling update 中短暂共存；整组消费者必须使用同一个可追溯的不可变 Billing 镜像 SHA。

迁移前必须先运行 `pnpm --filter @ruidong/api credit:backfill-balance-state`
做 legacy 账本/Redis 审计；命令退出码必须为 0，`isolated` 必须为 0。然后在
Billing 生产库执行下列只读查询，确认 `owner_mismatch=0`、
`missing_with_ledger=0` 且没有多态 scope ID 冲突：

```sql
WITH active_credit_scopes AS (
  SELECT
    period."id" AS subscription_id,
    period."user_id" AS scope_owner_user_id,
    'subscription_period'::text AS scope_kind
  FROM "subscription_periods" AS period
  JOIN "products" AS product ON product."id" = period."product_id"
  WHERE period."status" = 'ACTIVE'
    AND period."started_at" <= CURRENT_TIMESTAMP
    AND (period."expires_at" IS NULL OR period."expires_at" > CURRENT_TIMESTAMP)
    AND product."is_active"
    AND product."deleted_at" IS NULL

  UNION ALL

  SELECT
    entitlement."id",
    entitlement."user_id",
    'coding_plan_entitlement'::text
  FROM "coding_plan_entitlements" AS entitlement
  JOIN "products" AS product ON product."id" = entitlement."product_id"
  WHERE entitlement."status" = 'ACTIVE'
    AND entitlement."started_at" <= CURRENT_TIMESTAMP
    AND (entitlement."expires_at" IS NULL OR entitlement."expires_at" > CURRENT_TIMESTAMP)
    AND product."is_active"
    AND product."deleted_at" IS NULL
), scope_audit AS (
  SELECT
    scope.*,
    state."user_id" AS state_owner_user_id,
    EXISTS (
      SELECT 1
      FROM "credit_transactions" AS ledger_row
      WHERE ledger_row."subscription_id" = scope.subscription_id
    ) AS has_ledger
  FROM active_credit_scopes AS scope
  LEFT JOIN "credit_balance_states" AS state
    ON state."subscription_id" = scope.subscription_id
)
SELECT
  COUNT(*) FILTER (WHERE state_owner_user_id IS NULL) AS missing_state,
  COUNT(*) FILTER (
    WHERE state_owner_user_id IS NULL AND has_ledger
  ) AS missing_with_ledger,
  COUNT(*) FILTER (
    WHERE state_owner_user_id IS NOT NULL
      AND state_owner_user_id <> scope_owner_user_id
  ) AS owner_mismatch,
  COUNT(*) - COUNT(DISTINCT subscription_id) AS polymorphic_scope_id_conflicts
FROM scope_audit;
```

无历史账本且 legacy Redis 经审计为空的 `missing_state` 不会被猜测成历史余额；
新 Billing 会在 CREDITS 首次收件事务中锁定 scope、创建零状态，然后才写不可变
settlement anchor。`missing_with_ledger` 或 owner/scope 冲突不得由线上流量自动修复，
必须先用 verified backfill 或人工对账清零。

上线必须按以下顺序执行。以下任一条件不成立都属于 **NO-GO**：Release-B、v3 customer-authority 与本次 customer-settlement-policy-v2 三个完整 verifier 任一未通过；Billing runtime 数据库角色仍能变更 build authority 或 evidence rollout mode；关键财务终态告警尚未端到端送达。环境 allowlist / evidence mode 与数据库治理状态漂移仍必须告警和修复，但它们是 provider evidence 健康信号，不得阻断客户结算 consumer。

1. 构建并登记唯一的新 Billing 不可变镜像 SHA；部署配置显式设置 `BILLING_USAGE_EVIDENCE_CONTRACT_MODE=shadow`。首次启用 Kafka transport HMAC 时还应显式设置 `BILLING_USAGE_KAFKA_HMAC_MODE=shadow`，并同时装载至少一把带 `kid` 的 key，以先验证覆盖率；未经真实流量验证的候选 Gateway SHA 不得写入环境 allowlist 或数据库 authority。
2. 停止旧 Billing consumer 的自动拉起并执行 graceful drain。等待所有旧 Pod 退出、consumer group 成员数为 0、应用已确认 `in-flight=0` 后再继续。暂停期间 Kafka lag 可以增长；不要把“lag 为 0”误当成“无处理中消息”。
3. 在没有 Billing consumer 写入时执行数据库迁移和 Release-B rollout。随后必须以 `ON_ERROR_STOP=1` 依次执行 Release-B、v3 customer-authority 和本次 customer-settlement-policy-v2 三个完整 verifier；它们分别校验 Release-B 合同、v3 authority/provider-evidence 解耦，以及 v2 anchor gate 与两套资金证明函数，不能只运行应用内简化查询：

   ```bash
   psql "$BILLING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f apps/api/prisma/rollouts/20260717000100_balance_expiry_v2_contract/verify.sql

   psql "$BILLING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f apps/api/prisma/migrations/20260811000127_gateway_financial_terminal_provider_evidence_decoupling/verify.sql

   psql "$BILLING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
     -f apps/api/prisma/migrations/20260816000104_gateway_customer_settlement_policy_v2/verify.sql
   ```

4. Billing runtime 必须使用与 DBA/migration owner 分离的数据库角色。以 runtime 连接执行下列四项都必须返回 `false`；任一为 `true` 时禁止启动。两张控制表只给 runtime `SELECT`；表变更与两个受控函数仅 DBA/migration owner 可用：

   ```sql
   SELECT
     has_function_privilege(
       current_user,
       'public.append_gateway_producer_build_authorization(text,text,text,text,text)',
       'EXECUTE'
     ) AS runtime_can_authorize_build,
     has_table_privilege(
       current_user,
       'public.gateway_producer_build_authorization_events',
       'INSERT,UPDATE,DELETE'
     ) AS runtime_can_mutate_authority,
     has_function_privilege(
       current_user,
       'public.transition_gateway_usage_evidence_contract_mode(text,text,text,text)',
       'EXECUTE'
     ) AS runtime_can_transition_evidence_mode,
     has_table_privilege(
       current_user,
       'public.gateway_usage_evidence_contract_rollout_control',
       'INSERT,UPDATE,DELETE'
     ) AS runtime_can_mutate_evidence_mode;
   ```

   runtime 连接的会话隔离级别必须为 PostgreSQL `READ COMMITTED`，且连接池不得在单个事务中覆盖为更强的隔离级别：

   ```sql
   SELECT current_setting('transaction_isolation'); -- 必须是 read committed
   ```

   所有 Gateway 资金终态都会在 PostgreSQL deferred terminal guard 中无条件断言 `READ COMMITTED`：包括 BALANCE/CREDITS 扣费、NO_CHARGE/ABSORB 释放。数据库硬证明绑定持久化 provider evidence 的 HMAC/hash、首次 anchor、typed customer authority、receipt、TokenUsage、ledger/allocation 和 funding 数学一致性；Kafka transport HMAC 已由 consumer 在进入数据库事务前验证。provider build authorization/current tail 只服务内部 evidence 治理，不参与客户财务终态提交。

5. 以 recreate / 停机切换方式部署同一个新 Billing 镜像 SHA 到全部实例，再启动 consumer；禁止以 rolling canary 方式混跑两个 Billing SHA。consumer 在建立 Kafka 连接前会调用同一 Release-B 金融契约函数、执行角色隔离检查并确认数据库会话为 `READ COMMITTED`。环境 evidence mode/build 与数据库治理状态不一致时只记录内部 drift 告警，consumer 继续按安全客户结算语义运行。
6. 让新版本以 evidence `shadow` 和 Kafka HMAC `shadow` 覆盖 100% Billing 用量流量，核对 HMAC `mode/outcome` 指标、签名覆盖率、evidence 判定、Kafka commit/DLQ、不可变 evidence、receipt、TokenUsage、余额流水、供应商成本和平台损失产物。确认所有预期 Gateway producer 都签名且 keyring 已覆盖后，在 stop/drain 边界把 `BILLING_USAGE_KAFKA_HMAC_MODE` 切为 `required`；该切换独立于后续 evidence enforce 审批。
7. 再次 stop/drain。在该无 writer 窗口由 DBA/migration owner（不能是 Billing runtime 角色）以变更单和两个不同审批人登记固定 release SHA：

   ```sql
   SELECT append_gateway_producer_build_authorization(
     '<full-gateway-build-sha>',
     'AUTHORIZED',
     'CHG-12345',
     'finance-approver-id',
     'platform-approver-id'
   );
   ```

   撤销使用同一函数和 `REVOKED`，禁止直接 INSERT/UPDATE/DELETE。授权事件为追加式 hash chain，不能回填或覆盖。授权、撤销、重新授权都必须在 drained window 完成。
8. 用只读函数取得数据库按 DB 当前时间生效的集合，并将环境变量配置为相同集合，以保证 evidence 审计和 `NO_CHARGE` 应用判定准确；差异会产生 drift 告警，但不是普通客户结算的财务硬闸：

   ```sql
   SELECT * FROM current_gateway_producer_build_authorizations();
   ```

9. 保持 stop/drain、consumer group 成员数为 0 且 `in-flight=0`，由 DBA/migration owner 先提交数据库 rollout 变更，再把整个 Billing fleet 的环境配置一次性切换为 `enforce`：

   ```sql
   SELECT transition_gateway_usage_evidence_contract_mode(
     'ENFORCE',
     'CHG-12345',
     'finance-approver-id',
     'platform-approver-id'
   );
   ```

   函数要求变更单和两个不同审批人，runtime 无执行权限。DB 提交后，以同一个 Billing 镜像 SHA 和 `BILLING_USAGE_EVIDENCE_CONTRACT_MODE=enforce` 重启全部实例。金融 contract、runtime 角色隔离和 `READ COMMITTED` preflight 必须通过；DB/env evidence mode 的短暂 drift 会告警，但不得把已有 reservation 留在 ACTIVE 或阻断客户结算。

Gateway 可以独立按单 Pod/5% → 25% → 50% → 100% 金丝雀，并在每阶段核对 INPUT/CACHE/OUTPUT。Billing 仍保持 100% shadow；Gateway build 经真实流量验证后，再进入 DB authority 和环境 allowlist。未验证 build 会形成内部 evidence issue，并且不能触发应用层 `NO_CHARGE` 快路；NORMALIZED_EXACT 或 CUSTOMER_PROTECTIVE_ZERO 仍按 v3 冻结 authority 及时完成客户财务终态。

如需回滚，不要把已迁移数据库上的 Billing 直接退回旧二进制。优先 stop/drain 并暂停 Billing consumer；在零 writer 窗口由 DBA 用同一受控函数、独立变更单和两个审批人把数据库恢复为 `SHADOW`，同时把同一个兼容 Billing SHA 的环境配置恢复为 `shadow` 后再整体重启。Gateway 可暂停或切走受影响路由。恢复消费前确认单一 Billing SHA 和零 in-flight 切换边界；DB/env evidence mode 如仍漂移必须告警跟进，但不作为客户资金消费的恢复条件。

### 5.3 调试与验证

命令式 `quote`、`authorize`、`deduct` 仅保留在 admin 内部调试接口 `/api/internal/billing/admin/usage/*`，受 `BillingInternalGuard`、签名 admin context 和 `admin.system.manage` 权限约束。它不是 gateway fallback、本地入账或灾备通道。

### 5.4 低基数运行指标与告警建议

本轮指标只使用代码内固定 outcome，不允许 topic、partition、request ID、账户、Key、错误文本或 Publisher path 进入 label。backlog 和 oldest age 每轮从 PostgreSQL 当前状态重新聚合；聚合失败只增加 `metrics_query_failed` 并保留上一次 gauge，不会把已经完成的入账、restriction 投影或 Publisher 重试改判为失败。

| 指标 | 固定 label / 含义 |
| --- | --- |
| `ruidong_gateway_usage_evidence_contract_total{mode,outcome,issue}` | `mode` 仅为 `shadow/enforce`；`outcome=pass,issue=none` 表示完整通过，`outcome=issue` 的 `issue` 只能取代码内固定合同缺陷。不得将 request/account/build SHA 放入 label |
| `ruidong_billing_usage_kafka_messages_total{outcome}` | `committed`：broker offset 提交成功；`poison_dlq`：poison 消息已得到 DLQ broker 确认；`transient_uncommitted`：运行时失败耗尽本地重试且源 offset 保留；`dlq_send_failed`：DLQ 不可用或发送失败，源 offset 保留 |
| `ruidong_billing_restriction_projection_total{outcome}` | `succeeded` / `failed` / `skipped` 为单条 outbox 投影结果；`scan_failed` 为候选扫描失败；`metrics_query_failed` 只表示库存指标聚合失败 |
| `ruidong_billing_restriction_projection_backlog` | PostgreSQL 中所有非 `SUCCEEDED` restriction projection intent 数量 |
| `ruidong_billing_restriction_projection_oldest_age_seconds` | 上述 backlog 最早 `created_at` 距当前的秒数；无 backlog 时为 0 |
| `ruidong_publisher_retry_worker_total{outcome}` | `succeeded`、`retryable_failed`、`publisher_unavailable`、`exhausted`、`permanent_failed`、`retired`、`skipped`、`scan_failed`、`metrics_query_failed`；`exhausted` 与不可重试的 `permanent_failed` 独立统计 |
| `ruidong_publisher_retry_backlog` | PostgreSQL 中 `PENDING`、未终结 `FAILED`、`PROCESSING` Publisher job 数量 |
| `ruidong_publisher_retry_backlog_oldest_age_seconds` | 上述可重试 backlog 最早 `created_at` 距当前的秒数；无 backlog 时为 0 |

多 Pod 会各自暴露相同的数据库 gauge，因此库存告警使用 `max(...)`，不能 `sum(...)`；counter 则应跨 Pod `sum(increase(...))`。以下是首版门槛，需结合真实 QPS、worker interval 和 Kafka lag 基线调参：

```promql
# Shadow evidence-rollout 门槛：观测窗口内必须有真实通过流量，且合同缺陷为 0；
# 任一条件不满足都不得切换 evidence enforce，但不影响 v3 客户财务终态。
sum(increase(ruidong_gateway_usage_evidence_contract_total{mode="shadow",outcome="pass",issue="none"}[30m])) > 0
sum(increase(ruidong_gateway_usage_evidence_contract_total{mode="shadow",outcome="issue"}[30m])) == 0

# Enforce 后合同缺陷表示内部 evidence OPEN/告警，需要立即核对 Gateway build/路由；
# 它不表示客户财务事件被隔离。
sum(increase(ruidong_gateway_usage_evidence_contract_total{mode="enforce",outcome="issue"}[5m])) > 0

# Critical：DLQ 无法确认时源 offset 必须保留，任意一次都需要立即处理。
sum(increase(ruidong_billing_usage_kafka_messages_total{outcome="dlq_send_failed"}[5m])) > 0

# Warning / Critical：运行时依赖故障造成消息持续未提交。
sum(increase(ruidong_billing_usage_kafka_messages_total{outcome="transient_uncommitted"}[10m])) > 3
sum(increase(ruidong_billing_usage_kafka_messages_total{outcome="transient_uncommitted"}[10m])) > 30

# Warning；若 15 分钟超过 20 条升级 Critical，并抽样核对 poisonReason/DLQ 原文。
sum(increase(ruidong_billing_usage_kafka_messages_total{outcome="poison_dlq"}[15m])) > 0
sum(increase(ruidong_billing_usage_kafka_messages_total{outcome="poison_dlq"}[15m])) > 20

# Warning / Critical：restriction 已提交但长时间未投影到 Gateway。
max(ruidong_billing_restriction_projection_oldest_age_seconds) > 300
max(ruidong_billing_restriction_projection_oldest_age_seconds) > 900
max(ruidong_billing_restriction_projection_backlog) > 50

# Warning：restriction 处理、扫描或库存聚合出现失败。
sum(increase(ruidong_billing_restriction_projection_total{outcome=~"failed|scan_failed|metrics_query_failed"}[10m])) > 0

# Warning / Critical：Publisher 可重试任务持续积压。
max(ruidong_publisher_retry_backlog_oldest_age_seconds) > 900
max(ruidong_publisher_retry_backlog_oldest_age_seconds) > 3600
max(ruidong_publisher_retry_backlog) > 100

# Critical：已耗尽重试或明确永久失败；Warning：worker/库存查询异常。
sum(increase(ruidong_publisher_retry_worker_total{outcome=~"exhausted|permanent_failed"}[10m])) > 0
sum(increase(ruidong_publisher_retry_worker_total{outcome=~"scan_failed|metrics_query_failed"}[10m])) > 0
```

建议 oldest-age Warning 持续 5 分钟、Critical 持续 5 分钟再触发；`dlq_send_failed`、`exhausted` 和 `permanent_failed` 不设置等待。`committed=0` 不能单独告警，因为低流量时可能没有消息；应与 Kafka exporter 的 consumer-group lag 大于 0 联合判断，并按实际 exporter 指标名适配，例如：

```promql
sum(increase(ruidong_billing_usage_kafka_messages_total{outcome="committed"}[10m])) == 0
and on() sum(kafka_consumergroup_lag{consumergroup="billing-ledger-v1"}) > 0
```

这些 PromQL 只是规则建议，不代表生产告警已经上线。必须在目标集群验证 `/api/metrics` 可被 Prometheus 安全抓取、规则实际加载，并发送一条测试告警直到 Alertmanager 和最终值班渠道真实收到；在完成端到端送达验证前，不能宣称生产告警已上线。

## 6. Admin Billing API

Base URL: `BILLING_SERVICE_URL/api/internal/billing/admin`

鉴权使用 `x-internal-caller: admin-api`、`x-internal-token: <ADMIN_TO_BILLING_TOKEN>`、`x-billing-api-version` 和签名 admin context headers，同时由 admin 侧权限控制 `RequireAdminPermission` 约束具体操作。

| 分组 | 方法和路径 | 说明 |
| --- | --- | --- |
| 订单 | `GET /orders`, `GET /orders/:id`, `POST /orders/:id/cancel`, `POST /orders/:id/retry`, `POST /orders/:id/refund` | 订单查询、取消、重试、退款 |
| 运营统计 | `GET /stats`, `GET /revenue`, `GET /revenue/overview?days=`, `GET /finance-reports?month=`, `GET /transactions` | 仪表盘、收入、财务报表、流水 |
| 订阅 | `GET /subscriptions` | 用户订阅列表 |
| 套餐 | `GET /plans`, `GET /plans/:id`, `POST /plans`, `POST /plans/:id` | 套餐列表、详情、创建、更新 |
| 套餐价格 | `GET /plans/:id/prices`, `PUT /plans/:id/prices/:currency`, `DELETE /plans/:id/prices/:currency` | 多币种价格管理 |
| 组合套餐 | `GET /bundles`, `GET /bundles/:id`, `POST /bundles`, `PUT /bundles/:id`, `DELETE /bundles/:id` | bundle SKU 管理 |
| 产品 | `GET /products`, `POST /products`, `PUT /products/:id`, `DELETE /products/:id` | 产品管理，支持 `SUBSCRIPTION`、`PAY_AS_YOU_GO`、`CODING_PLAN` |
| 加量包 | `GET /booster-packs`, `POST /booster-packs`, `PUT /booster-packs/:id`, `DELETE /booster-packs/:id` | booster pack 管理 |
| 用户余额 | `GET /users/:id/balance`, `POST /users/:id/adjust-balance` | 查询和调额 |
| 用户积分 | `GET /users/:id/credit-overview`, `POST /users/:id/grant-credits`, `POST /users/:id/ensure-default-free-plan` | 积分概览、赠送积分、兜底 Free 套餐 |
| 支付实例 | `GET /payment-instances`, `POST /payment-instances`, `PUT /payment-instances/:id`, `DELETE /payment-instances/:id` | 支付渠道实例配置，敏感字段加密存储、响应脱敏 |
| PAYG 模型定价 | `GET /payg-model-pricing?productId=`, `PUT /payg-model-pricing`, `DELETE /payg-model-pricing?productId=&modelName=` | 产品级模型价格覆盖 |
| usage 调试 | `POST /usage/quote`, `POST /usage/authorize`, `POST /usage/deduct` | admin 内部的命令式报价/授权/扣费调试；不是 Gateway Kafka fallback，也不用于 evidence OPEN 修复 |
| Gateway 事件审计 | `GET /gateway-events`, `GET /gateway-events/:requestId`, `POST /gateway-events/:requestId/retry`, `POST /gateway-events/:requestId/manual-review`, `POST /gateway-events/:requestId/reconcile-settle`, `POST /gateway-events/:requestId/absorb`, `POST /gateway-events/:requestId/absorb-delta` | 查询不可变证据、v3 authority/结算回执；技术重试、选定证据结算、待结算吸收和已结算差额吸收分别独立授权 |
| 用量策略 | `GET /usage-policies?productId=`, `POST /usage-policies`, `PUT /usage-policies/:id`, `DELETE /usage-policies/:id` | 用户、分群、全局折扣和计价策略 |

Gateway 事件审计查询参数:

| 字段 | 说明 |
| --- | --- |
| `page`, `pageSize` | 分页，`pageSize` 最大 100 |
| `status` | `RECEIVED` / `QUARANTINED` / `DEDUCTED` / `DEBT_OPEN` / `ABSORBED` / `SKIPPED` / 失败状态 |
| `requestId` | 模糊匹配 gateway request id |
| `apiKeyId`, `userId`, `productId`, `modelName` | 精确或模型名模糊过滤 |

Admin API 透出相同能力:

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/gateway-billing-events` | 运营查询 gateway 事件入账列表 |
| `GET` | `/api/admin/gateway-billing-events/:requestId` | 查看首次 raw event、append-only evidence、v3 customer authority、资金结果和内部 OPEN 原因 |
| `POST` | `/api/admin/gateway-billing-events/:requestId/retry` | 仅重试 `RETRYABLE_FAILED + RETRY_WAIT` 技术/财务依赖故障，使用 CAS revision；provider evidence OPEN 不需要借此解除客户限制 |
| `POST` | `/api/admin/gateway-billing-events/:requestId/manual-review` | 将真实财务 `QUARANTINED` 转为人工复核；原因、操作者和幂等键永久留痕，不用于普通 provider evidence 缺失 |
| `POST` | `/api/admin/gateway-billing-events/:requestId/reconcile-settle` | 仅财务/超级管理员可选择 append-only evidence，对 `QUARANTINED + OPEN/MANUAL_REVIEW` 请求按相同 v3 customer assessment 结算；与首次 evidence hash 相同的不可变证据可缺 provider account/upstream 审计字段，不同 correction evidence 仍须严格绑定同一调用；CAS 和永久 receipt 保证资金只影响一次 |
| `POST` | `/api/admin/gateway-billing-events/:requestId/absorb` | 仅财务/超级管理员可将真实财务 `QUARANTINED + MANUAL_REVIEW` 敞口记为平台吸收；客户扣款恒为 0，并生成永久 receipt。provider evidence OPEN 不自动进入该动作 |
| `POST` | `/api/admin/gateway-billing-events/:requestId/absorb-delta` | 仅财务/超级管理员可对 `DEDUCTED/DEBT_OPEN + MANUAL_REVIEW + CONFLICTED` 请求选择独立权威证据，按冻结价格追加平台损失；客户补扣恒为 0，原账单/原回执不修改 |

旧 customer settlement v1 的 evidence-only `QUARANTINED/OPEN` 修复流程已经退役，当前合同不再提供基于旧 anchor 的 preview/apply 操作入口，也不允许把旧 basis 解释为 v2。非生产环境如仍有旧测试数据，应在停止 consumer 后独立清理或重建；不得按旧流程补扣、改写生产 anchor、receipt、TokenUsage 或客户余额。

### 6.1 无 settlement anchor 的历史聚合差额

2026 年 7 月供应商对账文件只有 `date + model + meter + providerUsage +
platformUsage` 聚合粒度，没有 `request_id/upstream_request_id`，也没有可直接采用的
金额。此类数据不能补造 settlement anchor，也不能修改客户余额、账单、TokenUsage 或原
settlement receipt。Billing 使用独立 maker/checker 历史损失批次：

- `PROVIDER_AGGREGATE` 行保留原始来源行、工作簿 SHA-256、规范化来源行 hash，按
  `provider/account/region/day/model/meter` 和 `source-file/row-hash` 双重永久 claim
  防止换行名后重复确认。
- 同一 `provider/account/region/day/model/meter` 的 coverage 由独立 registry 原子冻结为
  `REQUEST` 或 `AGGREGATE` 粒度。`REQUEST` 模式允许多个不同 request 各自留下
  request claim；一旦某一粒度被占用，另一粒度必须 fail-closed，防止同一差额既按
  逐请求又按不可分摊的供应商聚合重复确认。
- `MISSING_ANCHOR_REQUEST` 仅接受已经 `DEDUCTED/DEBT_OPEN` 且确实没有 anchor 的
  请求，并且必须与首次收件不可变事件的 occurredAt/serviceDate、provider/account/region、
  model/meter、platform token 维度和 upstream request id 逐项完全一致。旧事件缺少任一
  关联证据时只能走 `PROVIDER_AGGREGATE`。存在 anchor 时 preview 返回
  `SETTLEMENT_ANCHOR_PRESENT` 并要求改走
  `absorb-delta`。`SKIPPED/FAILED` 不具备既有客户结算语义，禁止进入此批次。
- 调用方只提交平台/供应商 Token 用量。金额由 Billing 按
  `TOKEN_RATE_PER_MILLION_V1 + HALF_UP_12` 重算；调用方提交任何金额/差额字段都会被
  拒绝。
- 每条费率必须同时绑定 `pricingSourceRef`、物理归档文件
  `pricingDocumentSha256`、规范化价目条目 `pricingEvidenceHash`、生效区间、审批人/时间
  和完整 `pricingEvidence`。Billing 重算条目 hash，并核对 model、meter、币种、费率和
  生效区间。这里是“有不可变价目证据的人工历史估值”，不是从当前可变 ModelPricing
  反推 7 月价格。
- 费率已归一到批次币种。若归一过程使用汇率，必须同时保留 exchange rate、来源币种、
  来源、时间，方向固定为 `BATCH_CURRENCY_PER_SOURCE_CURRENCY`；未使用汇率时四项全空。
- `preview -> create(PREPARED) -> approve-and-post(POSTED)` 全程绑定 canonical
  fingerprint、revision 和永久 idempotency key；创建人与审批人必须不同。只有 POST
  成功后才写全局 recognition claim。历史批次只确认平台损失，不改变客户 access state，
  也不能解除真实的 `settlement_policy_review` / debt restriction。Provider
  `evidence_conflict` 是内部审计事实；旧版本遗留的 active restriction 由 Gateway
  reconciliation projection 释放，不作为历史损失批次的客户关闸条件。
- `customerAbsorbedDelta` 和 `providerCostDelta` 是两个独立财务维度，不展示为可相加的
  “净损失”。负的 provider cost 差可在同一供应商账单范围内抵减；负的客户差额属于
  过收/退款流程，不得伪装成平台吸收。
- POSTED 批次、来源行、action、recognition claim 均由数据库 trigger 禁止 update/delete，
  且 `customerDeduction` 在行和批次级数据库约束中恒为 0。

Billing 内部接口：

| Method | Path | 权限 |
| --- | --- | --- |
| `POST` | `/internal/billing/admin/historical-platform-loss-batches/preview` | `admin.page.historical_platform_losses.prepare` |
| `POST` | `/internal/billing/admin/historical-platform-loss-batches` | `admin.page.historical_platform_losses.prepare` |
| `POST` | `/internal/billing/admin/historical-platform-loss-batches/:id/approve-and-post` | `admin.page.historical_platform_losses.approve_post`（preset 仅 finance/super_admin） |
| `GET` | `/internal/billing/admin/historical-platform-loss-batches[/:id]` | `admin.page.historical_platform_losses.view` |
| `GET` | `/internal/billing/admin/historical-platform-loss-batches/:id/export` | `admin.page.historical_platform_losses.export`，返回 `historical-platform-loss-export.v1` JSON |

当前边界：POSTED 后的供应商更正/操作错误尚无应用内 linked reversal API。因为批次完全
append-only，不能通过修改或删除“修正”错误；上线 POST 权限前必须把 preview fingerprint、
源文件 hash、价目证据和双人复核作为硬闸。需要冲销时只能先在受控财务总账中追加独立
补偿凭证并保留原 batch id，不能重新导入或覆盖本批次。linked compensating/reversal 批次
是完整会计闭环前的剩余阻断，因此本功能当前应称为“历史平台损失确认闭环”，不能宣称
已经完成可逆的完整会计闭环。

## 7. Publisher 联动

Publisher 文档中的三类接口已由代码统一封装:

| 业务事件 | Publisher API | 本地触发点 |
| --- | --- | --- |
| API Key 创建、更新、启停 | `PUT /portal/api/v1/keys` | `codesphere-user` provisioning outbox → `BillingAdminController` mirror → `PublisherSyncService`; legacy billing `ApiKeyService` 不由 `BillingRuntimeModule` 挂载 |
| API Key 删除、吊销 | `POST /portal/api/v1/revoked-keys`, `DELETE /portal/api/v1/keys/{key_hash}`, `DELETE /billing/api/v1/key-balance/{key_id}` | `codesphere-user` provisioning outbox → `BillingAdminController` mirror → `PublisherSyncService`; legacy billing `ApiKeyService` 不由 `BillingRuntimeModule` 挂载 |
| 余额、充值、扣费、订阅变化 | `PUT /billing/api/v1/key-balance/{key_id}` | `BillingService`、`UsageBillingStrategyService`、`RdclawService` |
| Channel、Model、Route 变化 | `/ops/api/v1/providers/*`, `/ops/api/v1/models/*`, `/ops/api/v1/key-pools/*` | `ChannelService`、`ChannelAdminService` |

身份映射:

| 本地字段 | Publisher 字段 | 说明 |
| --- | --- | --- |
| `ApiKey.id` | `key_id` | Publisher key-balance 的 `{key_id}`，gateway usage API 中传 `apiKeyId` |
| `ApiKey.keyHash` | `key_hash` | Publisher Portal KeyMeta 和 revoked key 使用 |
| `ApiKey.tenantId` | `scope_attrs.tenant_id` | 真实账号 / workspace id；PAYG、订阅和 CodingPlan key 均必填 |
| `ApiKey.userId` | `scope_attrs.user_id` | 创建人或操作者，仅用于审计 |
| `ApiKey.productId` | `scope_attrs.usr.product_id` | 产品维度策略 |
| `Product.slug` | `scope_attrs.usr.product_slug` | 产品 slug 维度策略 |

`key-balance` 请求体:

```json
{
  "has_balance": true,
  "revision": 1780000000000000
}
```

无额度时:

```json
{
  "has_balance": false,
  "reason": "balance_depleted",
  "revision": 1780000000000001
}
```

`reason` 映射:

| reason | 本地含义 |
| --- | --- |
| `balance_depleted` | 账号钱包余额小于等于 0 |
| `key_spend_limit_exhausted` | API Key 自身预算耗尽 |
| `workspace_budget_exhausted` | 预留给 workspace 预算，本地当前未启用 |

联动规则:

- gateway 写入 UsageEvent v2 时应提供 `key_id`。billing 使用本地 API Key 记录解析用户、产品、预算；扣费完成、扣费失败或幂等重放后，都会异步刷新该 key 的 Publisher `key-balance`。
- billing 如果当前库中找不到 `apiKeyId`，usage 链路不会误删 Publisher key-balance。真正删除只由 API Key 删除、吊销事件触发。
- 账号充值、管理员调额、余额缓存更新、订阅激活等账号级变更，会刷新该账号本地可见的 active API Key。
- Publisher 调用失败会写入 `publisher_sync_jobs`，后台 worker 按幂等键自动重试；不会阻塞主业务链路。生产必须监控 `FAILED` 且 `attempts >= maxAttempts` 的任务。
- admin 后台提供 `Publisher 同步任务` 页面，可查询失败任务、手动重试、按 `all/api_keys/key_balances/ops` 全量重推当前状态。

## 8. Publisher Client 配置

| 环境变量 | 说明 |
| --- | --- |
| `PUBLISHER_BASE_URL` | Publisher 服务根地址。不配置时 Publisher 同步为 no-op |
| `PUBLISHER_ENABLED=false` | 显式关闭 Publisher 同步 |
| `PUBLISHER_TOKEN` | 默认 token |
| `PUBLISHER_PORTAL_TOKEN` | Portal namespace token |
| `PUBLISHER_BILLING_TOKEN` | Billing namespace token |
| `PUBLISHER_OPS_TOKEN` | Ops namespace token |
| `PUBLISHER_SRE_TOKEN` | SRE namespace token |
| `PUBLISHER_TIMEOUT_MS` | Publisher 请求超时，默认 5000ms |
| `PUBLISHER_*_SERVICE_NAME` | 覆盖 `X-Service-Name` |
| `PUBLISHER_SYNC_WORKER_ENABLED=false` | 关闭 Publisher outbox 重试 worker |
| `PUBLISHER_SYNC_WORKER_INTERVAL_MS` | outbox 扫描间隔，默认 15000ms |
| `PUBLISHER_SYNC_WORKER_BATCH_SIZE` | 单次扫描处理条数，默认 20 |
| `PUBLISHER_KEY_BALANCE_BOOTSTRAP_ON_START` | 启动后扫描 active API Key 并补发 `gw:key_balance`，默认 `false` |
| `PUBLISHER_KEY_BALANCE_BOOTSTRAP_DELAY_MS` | key-balance bootstrap 延迟，默认 2000ms |
| `PUBLISHER_KEY_BALANCE_BOOTSTRAP_LIMIT` | key-balance bootstrap 单次扫描上限，默认 5000 |

Client 行为:

- 所有写请求自动带 `Authorization: Bearer <token>`、`X-Service-Name`、`X-Request-ID`、`Idempotency-Key`。
- 幂等键基于 namespace、method、path、body 生成；重复事件不会重复生效。
- `revision` 使用单调递增的 Unix microseconds，满足 Publisher 对版本覆盖的要求。
- Publisher 只接受 `202 Accepted` 成功响应；非 202 或错误 envelope 会转为 `PublisherClientError`，同步入口会落库等待重试。
- 未配置 `PUBLISHER_BASE_URL` 或 token 时，Publisher 同步为 no-op，不产生 outbox 任务。
- Channel 上游 key 新增/更新时，admin 默认用 `KMS_HMAC_SECRET` 按 gateway local KMS 合约加密，直接存储并下发 `enc:local:<base64(nonce|ciphertext|tag)>`；未配置 `KMS_HMAC_SECRET` 时兼容回退到 `ENCRYPTION_KEY`。
- AWS KMS 模式存储并下发 `enc:<base64(CiphertextBlob)>`；Publisher 只透传 `enc:` 密文，gateway 按自身 KMS 配置解密。

## 9. Gateway 接入要求

- gateway 必须先完成 API Key 鉴权，解析出 `apiKeyId`。
- `apiKeyId` 必须使用 admin 创建 API Key 时的 `ApiKey.id`，不能使用明文 key 或 key hash。
- gateway 事件中的 `tenant_id` 必须是真实账号 / workspace id；不能继续用 userId 填充。
- gateway 不需要理解用户、产品、套餐或折扣；billing 会根据 `apiKeyId` 在本地解析这些计费上下文。
- `idempotencyKey` 必须与一次最终扣费绑定，推荐包含 gateway request id。
- 必须记录 billing 返回的 `quote.policy`，用于排查用户折扣、分群折扣、全局折扣命中情况。
- 不能因为 `amountCents` 为 `0` 就跳过扣费。billing 内部使用高精度 USD 字段，小额请求可能低于 1 美分。
- `deduct.success=false` 时，gateway 不得本地补扣；只能提示额度不足、重试相同幂等键，或进入人工对账队列。
