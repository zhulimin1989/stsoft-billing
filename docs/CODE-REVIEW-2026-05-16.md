# Codesphere Billing 代码审查报告

| 项目 | `codesphere-billing` |
|------|---------------------|
| 审查日期 | 2026-05-16 |
| 审查范围 | 全面审查（架构 + 代码质量 + 安全 + Kafka/一致性 + 测试） |
| 架构 | pnpm monorepo（NestJS API，独立计费服务，无前端） |
| 规模 | 307 TS 源文件 |
| 特点 | 与 `codesphere-admin` 共享 `@ruidong/api` codebase，通过 `billing-main.ts` 启动，独立 `BILLING_DATABASE_URL` |
| 审查方式 | 只读静态分析（未运行、未修改任何代码） |

---

## 一、整体评分

| 维度 | 评分 | 关键观察 |
|------|------|---------|
| **服务边界** | 6/10 | 与 admin 共享代码导致模块隔离不彻底，DB 切换靠 env 而非编译期保证 |
| **计费核心一致性** | 4/10 | **5 个关键 Redis↔PG 一致性缺陷**，缺定期对账 worker |
| **Kafka 消费实现** | 5/10 | 手动 commit 实现存在，但缺死信队列、幂等缓存、消息签名 |
| **内部 API 鉴权** | 4/10 | token 用字符串比较（timing attack）+ fallback 到 SYNC_TOKEN |
| **测试完整性** | 6/10 | Service 单测扎实，Kafka/灾备/重放 E2E 缺失 |
| **代码质量** | 6/10 | Decimal 类型混用，`as any` 滥用 |

**核心结论**：billing 是整个 codesphere 体系的**钱袋子**，但当前在三个高风险维度上有显著缺陷 —— Redis 与 PG 双写一致性、Kafka 消费幂等、内部 API 鉴权。任何一个被利用都会直接导致**账目错乱或资金损失**。本周必须修 P0。

---

## 二、P0 严重问题（立刻修复）

### 🔴 一致性 / 资金安全

#### B1 Redis 扣费成功但 PG 写入失败 → 账本破裂
- **位置**：`apps/api/src/billing/credit.service.ts:9-55`（DEDUCT Lua）+ 后续 PG insert
- **问题**：Lua 已扣 Redis 后，若服务在 PG `creditTransaction.create` 前 OOM/网络中断，**Redis 被扣但 PG 无流水**。补偿 Lua 依赖应用层显式触发，崩溃即丢
- **影响**：用户余额不准；运营无法对账；资金会"凭空消失"
- **修复方向**：
  1. 引入 hourly reconcile worker：`MAX(creditTransaction.quotaAfter)` vs Redis 实时值
  2. Outbox 模式：扣费前先写 outbox 表，由后台 job 投递到 PG
  3. Prometheus 指标 `redis_pg_mismatch_total{reason=...}` 告警

#### B2 BillingInternalGuard timing attack + 鉴权降级
- **位置**：`apps/api/src/billing-runtime/billing-internal.guard.ts:23-31`
- **问题**：
  1. 用字符串 `===` 比较 token，可被 timing attack 穷举
  2. `BILLING_INTERNAL_TOKEN || SYNC_TOKEN` 的 fallback 让 admin 服务的 SYNC_TOKEN 可调 billing 内部 API
- **影响**：拿到 SYNC_TOKEN 即可调用 `POST /internal/billing/admin/users/{userId}/adjust-balance`、`refund` 等高权限端点
- **修复方向**：
  1. 改 `crypto.timingSafeEqual()`（项目 metrics controller 已有示例）
  2. 移除 SYNC_TOKEN fallback，强制 `BILLING_INTERNAL_TOKEN` 必填，缺失则启动失败

#### B3 Kafka RequestEvent 消费幂等性 + 消息无签名
- **位置**：`apps/api/src/billing-runtime/billing-usage-kafka-consumer.service.ts:51-78`
- **问题**：
  1. 用 `message.key` 作 requestId，但 Kafka 不保证 key 唯一；无 Redis 幂等缓存 → **rebalance 时重复消费导致重复扣费**
  2. payload 中的 `userId / amount / modelName` **完全信任**，无 HMAC 或 mTLS 校验
  3. 业务失败直接抛错 → 消费者 crash → rebalance → 同消息被反复消费 N 次
  4. 无死信队列（DLQ），无失败计数
- **影响**：恶意 producer 或网络故障都可能导致重复扣费或伪造扣费
- **修复方向**：
  1. Redis 幂等：`SET idempotency:${requestId} ${result} EX 86400 NX`，命中直接返回缓存
  2. 业务失败不抛错 → 改为更新 `GatewayBillingEvent.status=FAILED` + commit offset
  3. 失败 N 次 → 转 DLQ topic
  4. 消息添加 HMAC 签名（与 publisher 共享 secret）

### 🔴 计费核心代码

#### B4 addBonus 先 Redis 后 PG，补偿失败即永久脏数据
- **位置**：`apps/api/src/billing/credit.service.ts:393-457`
- **问题**：`deduct` 是"Lua 先扣 → PG 后写"，但 `addBonus` 是"Redis incrby 先 → PG insert 后"，方向相反。若 PG 失败且 `decrby` 补偿也失败，Redis 中的 bonus 永久虚高
- **影响**：用户多了积分但流水查不到，对账困难
- **修复方向**：统一所有写路径为"PG 先成功 → 再更新 Redis"

#### B5 Wechat/Alipay 回调金额未与本地订单交叉校验
- **位置**：`apps/api/src/payment/payment.controller.ts:239-263`
- **问题**：虽然验签通过，但 `decrypted.amount?.total` 直接信任，未与本地 `order.expectedAmountCents` 比对
- **影响**：若签名被泄露或网关 bug，金额可被篡改
- **修复方向**：回调处理时强制 `assert(decrypted.amount === order.expectedAmount)`，不一致直接拒绝并告警

---

## 三、P1 重要问题（本周内修复）

### 一致性 / 并发

| # | 问题 | 位置 |
|---|------|------|
| B6 | GRANT 池预检 (`peekGrantPool`) + Lua 间存在竞态，浪费扣款且增加延迟 | `apps/api/src/billing/credit.service.ts:31-39, 689-721` |
| B7 | `GrantRedemption.usedAmount` 与 Redis grant 池失同步无补偿 | `apps/api/src/billing/credit.service.ts:630-639` |
| B8 | 折扣码并发兑换无原子性：先 findByCode 再 update，竞态可绕过 `maxUsesPerUser=1` | `apps/api/src/campaign/discount-code.service.ts` |
| B9 | 缺少 hourly reconcile worker，Redis 脏数据完全靠人工发现 | `apps/api/src/billing/credit.service.ts:621-623` 自承 TODO |

### 服务边界 / 鉴权

| # | 问题 | 位置 |
|---|------|------|
| B10 | BillingRuntimeModule 加载了 `noopSyncServiceProvider`，SyncService 调用全部静默空转 | `apps/api/src/billing-runtime/billing-runtime.module.ts:24` + `noop-sync.provider.ts` |
| B11 | PrismaModule 全局化，DB 隔离靠 env 切换而非编译期保证 | `apps/api/src/billing-runtime/billing-runtime.module.ts:1-81` |
| B12 | 内部 API 无版本控制（X-API-Version），breaking change 无法识别 | `apps/api/src/billing/billing-internal.client.ts` |

### Kafka

| # | 问题 | 位置 |
|---|------|------|
| B13 | `partitionsConsumedConcurrently` 只控分区级，eachMessage 内 DB I/O 无背压，可能耗尽 PG/Redis 连接池 | `apps/api/src/billing-runtime/billing-usage-kafka-consumer.service.ts:53-56` |

---

## 四、P2 一般问题

| # | 问题 | 位置 |
|---|------|------|
| B14 | 金额精度：`Decimal.toNumber() * 100` 浮点链路，大金额会累积 1-2 cent 误差 | `apps/api/src/billing/billing.controller.ts`、`apps/api/src/billing/model-pricing.service.ts` |
| B15 | Schema 未在 `@db.Numeric(20, 12)` 明确精度，应用端 `toDecimalPlaces(12)` 与 PG 截断可能不一致 | `apps/api/src/billing/billing.service.ts:278, 302-304` + `prisma/schema.prisma` |
| B16 | `grantQuota` 幂等 P2002 走 catch → 二次 findUnique，额外 I/O；SETNX 回填缓存有读脏窗口 | `apps/api/src/billing/credit.service.ts:282-337` |
| B17 | webhook HMAC `maxAgeSeconds` 调用方可任意覆盖，无上限保护 | `apps/api/src/common/utils/hmac.util.ts:37` |
| B18 | Wechat 通知幂等 Redis key TTL 7 天，但 Wechat 可能在更长窗口重试 | `apps/api/src/payment/payment.controller.ts:56-59` |
| B19 | 非 prod 环境（staging）/metrics 默认匿名可访问，可被推断生产拓扑 | `apps/api/src/metrics/metrics.controller.ts:42-48` |
| B20 | `scripts/load-test-deduct.ts` 默认 BASE_URL 指向 test 服 + hardcoded placeholder token，存在误执行风险 | `scripts/load-test-deduct.ts:25-29` |
| B21 | CORS 用正则 match `/api/payment/notify/` 跳过检查，应改白名单 | `apps/api/src/billing-main.ts:81-89` |
| B22 | Kafka 灾难恢复、webhook 重放、Redis 断连无 E2E 演练 | `apps/e2e/tests/` 缺口 |

---

## 五、P3 建议项

- 生产代码 `(err as { code?: string }).code` 不安全转换 → 改 unknown + type guard
- Prisma.Decimal / string / number 三态混用 → 定义统一 `DecimalLike` 类型
- 配额过期 job 与查询余额间存在 race window，应加快照 timestamp
- 批量赠送（`grantCredits`）应增加上限校验（如单次 ≤ 10000）防止上游 bug 放大
- billing 服务也建议加 Docker `USER` 非 root（与 admin 相同问题）

---

## 六、修复优先级路线图

| 周期 | 任务 |
|------|------|
| **本周（W1）** | **B1** Reconcile worker（hourly）+ outbox；**B2** timingSafeEqual + 移除 SYNC_TOKEN fallback；**B3** Kafka Redis 幂等 + DLQ + 不抛错；**B5** 支付回调金额交叉校验 |
| **第 2 周** | **B4** 统一 PG-first 写顺序；**B8** 折扣码改 Redis 分布式锁或 PG 行级锁；**B9** 上线 mismatch 指标与告警 |
| **第 3-4 周** | **B6/B7** GRANT 路径重构 + 对账；**B10/B11** 把 noopSync 改成显式 warn + Prisma 启动期校验 BILLING_DATABASE_URL；**B13** 引入全局 semaphore |
| **第 5-6 周** | **B14/B15** Decimal 统一化（全链路用 Prisma.Decimal，禁 `toNumber()`）；补 Kafka 灾备、webhook 重放、Redis 断连 E2E |
| **持续** | API 版本控制、错误规范、TypeScript 严格化 |

---

## 七、问题分布统计

| 等级 | 一致性/资金 | 安全/鉴权 | Kafka | 服务边界 | 代码质量 | 合计 |
|------|-----------|---------|-------|---------|---------|------|
| P0 | 2 | 2 | 1 | 0 | 0 | **5** |
| P1 | 4 | 0 | 1 | 3 | 0 | **8** |
| P2 | 1 | 2 | 0 | 1 | 5 | **9** |
| P3 | 1 | 0 | 0 | 0 | 4 | **5** |
| **合计** | **8** | **4** | **2** | **4** | **9** | **27** |

---

## 八、与 admin review 的关联

billing 共享 `@ruidong/api` codebase，所以以下 admin review 中已记录的问题**同样适用于 billing**，本报告未重复：

- 加密密钥 padding（`credential-crypto.ts`）— **P0**
- Auth0 audience 验证过宽（`auth0-verifier.service.ts`）— **P0**
- Redis Key CRLF 注入（`admin-permission.guard.ts`、`payment.controller.ts`）— **P0**
- Docker root 运行 — **P1**
- HTTP filter stack 泄露 — **P1**
- Prisma `$queryRaw` 过度使用 — **P1**
- `payment.service.ts` 2210 行 / `forwardRef` 循环依赖 — **P1**
- Prisma 软删除中间件缺失 — **P1**

修复时应**跨仓库同步**：在共享 codebase 上修一次，两个服务同时受益。详见 `codesphere-admin/docs/CODE-REVIEW-2026-05-16.md`。

---

## 九、审查范围说明

**已覆盖**：
- 服务边界与模块组织（`billing-main.ts` 启动加载链）
- 计费核心代码（`billing/`、`credit-policy/`、`credit-grants/`、`recharge-tiers/`、`quota-templates/`）
- Kafka 消费者实现（`billing-runtime/billing-usage-kafka-consumer.service.ts`）
- Redis vs PG 一致性（Lua 脚本、补偿逻辑、对账缺口）
- 内部 HTTP API 鉴权（`billing-internal.guard.ts`）
- 支付回调安全（金额校验、防重放、签名验证）
- 折扣码、配额、过期积分的并发与边界
- 金额与精度（Decimal vs Number）
- 观测面暴露（`/metrics`、Sentry、日志）
- 测试文件分布与覆盖范围

**未覆盖**（建议后续补充）：
- 实际 Kafka 集群消费速率压测与背压观测
- PG 慢查询、索引、事务死锁分析
- 真实生产环境对账数据回溯
- Sentry 中支付相关错误聚合分析
- 微信/支付宝 SDK 版本与 CVE 比对

---

*本报告由静态代码审查生成，所有问题位置均可直接跳转到对应行号。修复时建议按 P0 → P1 → P2 顺序执行，并对每个修复编写回归测试。billing 是资金核心系统，所有 P0 修复都必须配套监控告警和回滚预案。*
