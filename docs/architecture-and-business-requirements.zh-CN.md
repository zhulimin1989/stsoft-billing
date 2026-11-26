# codesphere-billing 技术架构与业务需求说明

本文档基于 `origin/test` 分支截至 2026-06-22 的代码现状整理，覆盖 `codesphere-billing` 仓库的技术架构、运行边界和业务需求。

## 1. 仓库定位

`codesphere-billing` 是独立计费服务仓库，负责产品、套餐、订阅、订单、支付、余额、积分、API Key 计费镜像、Gateway 用量入账、模型定价、供应商成本、渠道、Publisher 同步和运营侧计费管理接口。

本仓库拥有：

- `apps/api`：包含两个生产 runtime：
  - billing runtime，生产入口为 `dist/billing-main.js`。
  - partner OpenAPI runtime，生产入口为 `dist/openapi-main.js`，用于外部产品接入 facade。
- `packages/shared`：本服务 API 与其它端复用的类型、schema 和错误码。
- `apps/e2e`：计费服务 API 级 e2e 测试。
- `apps/api/prisma`：`ruidong_billing` 的 Prisma schema、迁移和 seed。

本仓库不拥有：

- 用户身份认证主数据。billing 只保存用于计费、账务、路由和镜像的用户/租户 snapshot。
- 后台账号、后台角色和后台控制面登录态。
- 用户门户前端。

## 2. 技术架构

### 2.1 总体形态

仓库采用 pnpm workspace：

- 根目录脚本负责编排 Prisma generate、shared build、API build、测试、e2e、数据库边界检查和 capability axis freeze 检查。
- `apps/api` 是 NestJS 11 + Fastify 服务，使用 Prisma、Redis、JWT、Pino、Sentry、Prometheus、BullMQ、Kafka、Stripe、微信支付、支付宝、KMS/HMAC 和 Publisher contracts。
- 没有通用 `AppModule` 生产入口；billing runtime 由 `BillingRuntimeModule` 独立装配，避免把 user/admin 旧边界带入 billing 服务。

### 2.2 API 运行时

billing 生产入口是 `apps/api/src/billing-main.ts`：

- 启动前执行 `instrument.ts` 初始化 Sentry/OpenTelemetry。
- 设置 `RUIDONG_SERVICE=billing`。
- 使用 Fastify，开启 2MB body limit、60 秒请求超时、72 秒 keep-alive。
- 捕获支付通知 raw body，便于微信、支付宝、Stripe 回调签名校验。
- 全局前缀为 `/api`，URI versioning 前缀为 `/v`。
- 非生产环境暴露 Swagger：`/api/docs`。
- 默认监听 `BILLING_PORT`、`PORT` 或 `3010`。

partner OpenAPI 生产入口是 `apps/api/src/openapi-main.ts`：

- 设置 `RUIDONG_SERVICE=openapi`，避免 billing-only worker 在公网 facade 进程中运行。
- 不挂载 billing 全局用户/admin JWT guard，也不暴露 `/api/internal/*`。
- 暴露 `/partner/v1/*`，由产品 integration token 鉴权。
- 非生产环境默认暴露 `/docs`、`/openapi.json`；生产环境需显式设置 `OPENAPI_DOCS_ENABLED=true` 才暴露。
- 默认监听 `OPENAPI_PORT`、`PORT` 或 `3030`。

`BillingRuntimeModule` 装配以下能力：

- `PrismaModule`：连接 `BILLING_DATABASE_URL` / `ruidong_billing`。
- `RedisModule`：缓存、幂等、限流和 worker 依赖。
- `PublisherModule`：API Key、余额、渠道和运行时意图同步到 Publisher/Gateway。
- `ProductConfigSyncModule`：产品配置变更 webhook 同步。
- `PaymentRuntimeModule`：支付和通知处理运行时。
- `ProductRouteModule`：产品渠道、分组、路由图和 route assignment。
- `BillingHttpModule` / `BillingCoreModule`：计费核心服务和 public billing 控制器。
- `UserSegmentsModule`：分群逻辑和 internal admin 入口。
- `BillingAdminController`、`BillingWorkspaceMirrorController`、`ProductRouteAdminController` 等 internal/runtime 控制器。
- `BillingAuthGuard`：全局用户/admin JWT 鉴权，public 接口除外。
- `BillingInternalGuard`：internal 调用方鉴权和路由白名单。
- `HttpExceptionFilter`：统一错误响应。

### 2.3 核心模块

计费核心位于 `apps/api/src/billing`：

- `BillingService` / `BillingRepository`：套餐、订阅、订单、余额、交易等核心读写。
- `CreditService`：积分/余额扣减、授予、退款、阈值检查。
- `SubscriptionLifecycleService` / `SubscriptionResolverService` / `SubscriptionExpiryService`：订阅生命周期、有效订阅解析和过期处理。
- `CreditPricingService`、`ModelPricingService`、`ProviderCostPricingService`、`UsageBillingStrategyService`：模型售价、供应商成本、用量计费策略和结算口径。
- `GatewayRequestEventBillingService`：Gateway usage event 处理和入账。
- `CodingPlanProvider*`、`CodingPlanResaleRouteService`：CodingPlan 三方转售、上游权益、供应商线路、上游 key 展示与使用统计。
- `ProductService`、`ProductIntegrationAuthService`：产品配置、产品 token 和 webhook/integration token。
- `BoosterPackService`、`BalanceGrantExpiryService`、`RollingQuotaGateConfigService` 等运营辅助能力。

支付位于 `apps/api/src/payment`：

- 支付渠道包括微信、支付宝、Stripe、余额支付。
- 订单创建、支付状态、订单列表/详情、取消、通知回调、退款补偿由 billing 执行。
- 支付回调 raw body 由 Fastify preParsing hook 捕获，服务内完成验签。

运行时和异步能力：

- `BillingUsageKafkaConsumerService` 可消费 Kafka `gateway.usage_events`，支持 HMAC 验签、Snappy、重试、幂等缓存、DLQ 和手动 commit。
- `CreditReconcileWorkerService`、`RefundCompensationWorkerService`、`AccountingReconciliationService` 负责账务修复和对账。
- `ProductConfigSyncService` 通过签名 webhook 把产品配置变更同步到外部产品。
- BullMQ 用于 webhook 等异步投递。

### 2.4 数据所有权

billing 拥有 `BILLING_DATABASE_URL` 对应的 `ruidong_billing`。主要模型包括：

- 身份快照与账户：`User`、`Tenant`、`TenantMember`、`BillingAccount`、`AccountWallet`、`BillingAccountMember`。
- 产品与定价：`Product`、`ProductRuntimePolicy`、`Plan`、`PlanPrice`、`BoosterPack`、`BundleSku`、`BundleSkuItem`、`RechargeTier`。
- 订阅与权益：`UserSubscription`、`SubscriptionContract`、`SubscriptionPeriod`、`SubscriptionEntitlement`、`TenantProductEntitlement`、`CodingPlanEntitlement`、`CodingPlanProviderEntitlement`。
- 支付与订单：`Order`、`OrderItem`、`OrderAuditLog`、`PaymentProviderInstance`、`RefundCompensationTask`、`StripeEvent`。
- 余额与积分：`CreditTransaction`、`BalanceTransaction`、`BalanceGrant`、`BalanceConsumptionAllocation`。
- API Key 与用量：`ApiKey`、`TokenUsage`、`GatewayBillingEvent`。
- 供给与路由：`Channel`、`ProductChannel`、`ProductChannelGroup`、`RouteAssignment`、`ModelAccess`、`ModelRoutePolicy`、`ModelPricing`、`ModelPricingTier`、`PaygModelPricingPolicy`、`ProviderModelCostPolicy`。
- 运营配置：活动、促销码、分群、配额模板、风控、工单、告警、信用策略、邀请裂变等。
- 同步任务：`PublisherSyncJob`、`ProductConfigSyncJob`。

`PrismaService` 在 `RUIDONG_SERVICE=billing`、`RUIDONG_SERVICE=openapi` 或 `SERVICE_ROLE=billing` 时使用 `BILLING_DATABASE_URL`；生产环境未配置会 fail-fast。`scripts/check-db-boundaries.mjs` 禁止 billing runtime 引入 legacy `AppModule`、user/admin 模块、非 billing 数据库 URL 和跨边界扩表。

### 2.5 对外与对内接口

public/user 侧接口：

- `/api/billing/*`：套餐、活动、组合包、余额、订阅、CodingPlan 权益、积分、交易、token usage、产品、加油包、充值面额、日报/月报、导出。
- `/api/payment/*`：创建订单、支付方式、订单状态/列表/详情、取消订单、支付通知。
- `/api/v1/models/catalog`：模型目录。
- `/api/v1/tickets`：用户侧工单。
- `/api/billing/recharge-tiers`：公开充值面额。

admin internal 接口：

- `/api/internal/billing/admin/*`：由 admin-api 调用，覆盖订单、收入、报表、订阅、按量账号、Gateway event、Publisher job、产品、套餐、活动、促销码、配额、积分发放、信用策略、渠道、模型、成本、支付配置、usage policy 等后台管理动作。

user internal 允许接口：

- API Key mirror 创建/更新/吊销和 spend 查询。
- 默认产品查询、默认免费计划发放。
- workspace mirror、workspace balance、allowance。
- CodingPlan entitlement 查询。
- 用量统计、token usage、recent orders。

partner 外部接入接口：

- `/partner/v1/product/current`：产品 token 解析出的当前产品。
- `/partner/v1/catalog/*`：产品域 catalog 查询，包括 products、plans、booster-packs、models、model-access、model-route-policies、channels；当前不公开组合包和模型价格目录。
- `/partner/v1/tenants/provision`：外部 SaaS 自动开通 user/tenant/default entitlement/virtual API Key。
- `/partner/v1/payment/*`：创建可安全兑现的订阅、加油包和充值订单，并查询支付方式与订单状态；历史组合包订单只读可查，不接受新建。
- `/partner/v1/billing/*`：查询当前订阅、积分余额与交易、账单交易和日/月汇总。
- partner API 不接受外部传入 `productId` / `productSlug` 作为身份选择器；产品身份只从 integration token 得出。

### 2.6 安全与边界

billing 的鉴权层包含：

- `BillingAuthGuard`：验证用户 `access_token`、admin `admin_access_token` 或 Bearer token。非 admin 用户访问时会确保 billing user mirror 存在。
- `BillingInternalGuard`：要求 `x-internal-caller`、调用方专属 token、`x-billing-api-version`，并按 caller 做路由白名单。
- 产品 token 鉴权：`PartnerApiAuthGuard` 只在 OpenAPI runtime 中解析产品集成 token；billing internal 路由不接受产品 token。
- 支付通知验签：支付服务验证微信、支付宝、Stripe 的回调签名。
- Kafka usage HMAC：生产必须显式设置 `BILLING_USAGE_KAFKA_HMAC_MODE=shadow|required`，缺失或 `off` 均启动失败；首次迁移先用 `shadow` 验证覆盖率，稳定态切 `required`。必须配置带 `kid` 的启动期内存 keyring（单 key 使用 `BILLING_USAGE_KAFKA_HMAC_KEY_ID` + `BILLING_USAGE_KAFKA_HMAC_SECRET`，轮换使用 `BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON`）和 DLQ topic。
- 生产 secret 校验：`assertProductionSecrets` 阻止占位 secret 上线。
- URL guard、HMAC、加密 key 解析等通用工具用于 webhook 和外部同步。

### 2.7 观测、部署与测试

- `/api/health/live`、`/api/health/ready` 和 `/api/health` 提供健康检查。
- `/api/metrics` 提供 Prometheus 指标。
- Sentry 覆盖 API。
- billing Docker 入口必须是 `node dist/billing-main.js`；OpenAPI Docker 入口必须是 `node dist/openapi-main.js`。
- 生产迁移入口：`pnpm db:migrate:prod`，内部要求 `BILLING_DATABASE_URL`。
- 常规验证：`pnpm db-boundary:check`、`pnpm capability-axis-freeze:check`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`。

## 3. 业务需求

### 3.1 产品和商业模式

billing 需要支持三类产品商业模式：

- `SUBSCRIPTION`：订阅套餐，按周期授予权益和配额。
- `PAY_AS_YOU_GO`：按量计费，基于账户余额、价格策略、模型用量和折扣策略扣费。
- `CODING_PLAN`：面向 CodingPlan 的自营/三方计划，支持配额模板、上游权益、转售线路和 API Key 绑定。

核心需求：

- 产品是套餐、充值、渠道、路由、模型访问和 webhook 同步的上游。
- 产品 runtime policy 和 route policy 变更需要可同步到相关运行时。
- 产品集成 token、webhook secret 需要可轮换且不能明文外泄。

### 3.2 订阅和权益

billing 需要管理订阅购买、续期、有效期、合同期、订阅 period、entitlement 和历史记录。

核心需求：

- `user_subscriptions` 是历史 period 表，只允许每个 tenant/product 有唯一 ACTIVE 行。
- 订阅创建和变更必须生成可追踪的订单、period 和 entitlement。
- 过期订阅需要由 worker 或服务逻辑处理。
- 免费默认计划可由 user onboarding outbox 调用 billing 发放。

### 3.3 余额、积分和按量扣费

billing 需要同时支持余额账本、积分账本、加油包、充值赠送、授信额度和扣费策略。

核心需求：

- 余额/积分变动必须通过交易表记录。
- API Key 级预算、workspace allowance、tenant 账户余额和欠费策略需要统一结算。
- 用量扣费必须幂等，按 requestId / idempotency key 防重复。
- 生产默认不允许负余额入账，除非事故 runbook 明确覆盖。
- 需要支持信用额度策略、逾期用户查看、恢复条件和自动触发动作。

### 3.4 支付和订单

billing 需要支持微信、支付宝、Stripe 和余额支付，覆盖订阅、加油包、充值和组合套餐。

核心需求：

- 订单状态覆盖 PENDING、PAID、FULFILLING、COMPLETED、EXPIRED、CANCELLED、FAILED、REFUNDING、REFUNDED、REFUND_FAILED、REFUND_COMPENSATION_FAILED。
- 支付回调必须验签，并保留原始 payload 支持验签。
- 支付通知、退款和补偿必须可重试、可审计、可对账。
- 后台发起取消、重试、退款等动作时，真实执行仍由 billing 完成。

### 3.5 Gateway 用量入账

billing 是生产 billable usage 的账务权威。

核心需求：

- Gateway 生产用量事件必须进入 Kafka `gateway.usage_events`；HTTP usage fallback 已废弃，生产关闭 Kafka consumer 会 fail-fast。
- Kafka 消息需要 HMAC 验签、幂等缓存、有限重试、DLQ 和显式 commit。
- `GatewayBillingEvent` 记录处理结果、错误原因和 retry 能力。
- 模型访问拒绝等确定性业务失败不能静默漏账，需要 DLQ 和告警。

### 3.6 API Key 镜像和 Publisher 同步

billing 保存用户 API Key 的计费镜像，并负责激活 Publisher/Gateway 运行时状态。

核心需求：

- user-api 创建本地 API Key 后只能进入 `PROVISIONING`，由 outbox 调 billing mirror。
- billing 接收 mirror 后同步 keymeta/key_balance 到 Publisher/Gateway。
- API Key 禁用、吊销、预算、限流、模型范围、CodingPlan entitlement 绑定必须同步到运行时。
- Publisher sync job 需要支持查看、重试和 replay。

### 3.7 CodingPlan 自营与转售

billing 需要支持自营 CodingPlan 和三方转售 CodingPlan。

核心需求：

- 自营套餐使用 `PlanQuotaTemplate` / `PlanQuotaRule` 描述实际执行的限额规则。
- 三方转售通过 `CodingPlanProviderLine`、`CodingPlanProviderProduct`、`CodingPlanResaleRoute`、`CodingPlanProviderEntitlement` 管理上游供应商、产品、路由和权益。
- 上游 key reveal、usage trend、权益 retry、provider line test/sync-products 都需要受 admin 权限保护。
- capability axis freeze 要防止重新引入散乱 capability/param admission 轴。

### 3.8 模型、渠道、路由和成本

billing 需要管理模型目录、模型访问策略、模型路由策略、供应商渠道、产品渠道分组、路由图、按量价格和供应商成本。

核心需求：

- 模型售价和供应商成本支持多版本、时间窗口、provider line 和优先级。
- 产品渠道、分组、成员和 route assignment 决定网关实际流量路由。
- 渠道 secrets 必须加密或通过 KMS/HMAC 管理。
- 配置变化需要通过 Publisher 或 product config sync 生效。

### 3.9 运营域

billing 同时承载一部分运营后台数据和 internal 管理逻辑：

- 活动、促销码、组合套餐、邀请裂变。
- 用户分群、积分发放规则、信用政策。
- 风控规则、风险名单、风险用户。
- 工单、告警事件、漏斗分析。
- 财务报表、收入概览、交易流水、对账。

这些能力服务于 admin 控制台，但业务数据的权威位置在 billing。

## 4. 非功能需求与约束

- billing 不得依赖 user/admin 数据库写入业务状态。
- 生产环境必须使用 `BILLING_DATABASE_URL`，不能 fallback 到 `DATABASE_URL`。
- internal API 必须校验 caller、token、版本和路由范围。
- 所有账务变动必须幂等、可审计、可重放或可解释。
- 支付 provider secret、渠道 secret、KMS/HMAC secret 不能出现在前端或 admin DB。
- 新增 capability/feature/param admission 轴前必须通过架构审查并更新 freeze baseline。
- Kafka usage 生产启用时必须配置 brokers、HMAC 和 DLQ。
- 新增外部 webhook 目标必须通过 URL guard，并使用 HMAC 签名。

## 5. 关键入口

- API 入口：`apps/api/src/billing-main.ts`
- 运行时模块：`apps/api/src/billing-runtime/billing-runtime.module.ts`
- 计费核心模块：`apps/api/src/billing/billing-core.module.ts`
- 计费用户接口：`apps/api/src/billing/billing.controller.ts`
- 计费后台 internal：`apps/api/src/billing-runtime/billing-admin.controller.ts`
- 用量 Kafka 消费：`apps/api/src/billing-runtime/billing-usage-kafka-consumer.service.ts`
- Gateway 用量入账：`apps/api/src/billing/gateway-request-event-billing.service.ts`
- 支付模块：`apps/api/src/payment/payment.module.ts`
- API Key/Publisher 同步：`apps/api/src/publisher`
- 产品配置同步：`apps/api/src/integration/product-config-sync`
- Prisma schema：`apps/api/prisma/schema.prisma`
- 数据库边界检查：`scripts/check-db-boundaries.mjs`
- Capability freeze：`scripts/check-capability-axis-freeze.mjs`
