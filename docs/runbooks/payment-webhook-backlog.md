# Runbook — 支付回调积压 / 处理异常（money path）

**严重度默认**：**P0**（money path，任何异常都至少 P1；涉及资损或订单不对账直接 P0）
**适用范围**：
- **入站**支付回调（同步处理）：
  - `POST /api/payment/notify/wechat`（微信 V3，`PaymentController.wechatNotify`）
  - `POST /api/payment/notify/alipay`（支付宝 form，`PaymentController.alipayNotify`）
  - `POST /api/payment/notify/stripe`（Stripe，`PaymentController.stripeWebhook`）
- **出站**事件 webhook（异步 BullMQ）：
  - 队列 `integration-webhook`（`apps/api/src/integration/webhook/`）
  - 这是平台主动向下游推送，不是收支付回调

> **架构事实**（跟 `CLAUDE.md` 旧描述不一致，以代码为准）：
> **支付 provider 的回调是同步处理** — 回调进来后在 HTTP handler 内就完成验签、replay 保护（Redis 幂等键）、`paymentService.handlePaymentCallback()` 写库 + 发货。
> `integration-webhook` BullMQ 队列是"平台发给商户/下游"的 outbound 链路，不是接收支付方回调的缓冲。
> **因此支付"积压"不存在于 BullMQ 队列里，而存在于：provider 那边的重试队列 + 本地的失败日志 + 数据库里未完结的 Order。**

---

## 1. 症状

三条并行关注：

### 1A. 入站支付回调处理异常（最关键）

- **Sentry**：`支付宝回调处理失败` / `微信回调处理失败` / `Stripe webhook 处理失败` 密集出现
- **用户报障**：支付了但订单一直 `PENDING`、余额没到账、Stripe 侧显示成功本地看不到
- **API 日志**：
  ```bash
  docker logs ruidong-console-api --tail 1000 | grep -iE 'notify|webhook|支付宝|微信|stripe' | tail -40
  ```
- **PG 视角**：`Order.status = 'PENDING'` 且 `created_at > 5 分钟前` 数量激增
- **Provider 侧**：支付宝/微信商户后台的"异步通知失败记录" 持续累加，Stripe Dashboard → Developers → Webhooks 里 attempts 大量 500/400

### 1B. Outbound webhook（`integration-webhook`）积压

- BullMQ `wait` / `delayed` 队列长度异常，`active` 不推进
- 订阅这个 webhook 的下游（例如企业客户的订单同步）投诉收不到事件

### 1C. 验签一直失败（配置问题）

- 所有回调返回 401（支付宝）/ 500（微信）/ 400（Stripe）
- 用户投诉 "支付方扣了但平台不确认"

---

## 2. 影响

| 场景 | 影响 | 资损风险 |
|------|------|---------|
| 回调全挂（1A） | 所有支付不到账，订单卡 PENDING，用户感知"我付了没到账" | **高**：超时后用户可能二次支付，或客诉退款 |
| 回调部分挂（某个 provider） | 该渠道的用户受影响 | 中 |
| 验签失败（1C） | 平台侧视角：完全收不到成功事件 | 高（和 1A 同） |
| Outbound 积压（1B） | 下游收不到事件，但本地订单已 PAID | 低（不影响主交易），但 B2B SLA 可能违约 |

**money path 铁律**：
1. **不允许"先盲目重试所有失败消息"**。每次重放前必须先对账当前状态。
2. 任何人工操作前先截图 `Order` + `OrderAuditLog` 当前快照（章节 4.1）。
3. 再次操作资金类写入必须用 `idempotencyKey`（`Order.idempotencyKey` 已有唯一约束）。

---

## 3. 第一响应（5 分钟内）

```bash
# 1) 确认回调到底有没有进到 API（Nginx 访问日志）
sudo tail -n 500 /var/log/nginx/access.log | grep -E 'POST /api/payment/notify' | tail -20
# 期望：每分钟几到几十条。0 条 → 可能 Nginx 层有问题或 provider 还没发来；跳 4.4

# 2) API 处理回调的成功/失败近况
docker logs ruidong-console-api --since 15m 2>&1 | grep -E '(notify|webhook).*(处理失败|验签|跳过|SUCCESS|delivered)' | tail -30

# 3) PG 里过去 30 分钟内异常订单
docker exec ruidong-postgres psql -U ruidong -d ruidong_console_saas <<'SQL'
SELECT status, channel, count(*)
FROM "Order"
WHERE created_at > now() - interval '30 minutes'
GROUP BY status, channel
ORDER BY status, channel;
SQL

# 4) /health/ready 看依赖是否健康（回调靠 PG + Redis）
docker exec ruidong-console-api sh -c "curl -s http://localhost:3000/health/ready"

# 5) 如果全线 PENDING 激增 + /health/ready degraded → 按底层先修（db-down / redis-down）
```

**初步决策**：

- 回调进不来（Nginx 0 条）→ 跳 4.4（Nginx / ALB / DNS / TLS）
- 回调进来但 500/400 → 跳 4.1（验签 / replay / DB 写入）
- 回调成功但订单状态没动 → 跳 4.2（`handlePaymentCallback` 内部）
- **任何情况下禁止立刻在 provider 后台点"重新推送"** — 先对账！

---

## 4. 诊断

### 4.1 入站回调处理失败（1A）

#### 4.1a 哪个 provider

```bash
docker logs ruidong-console-api --since 30m 2>&1 \
  | grep -E '处理失败|notify.*fail|webhook.*fail' \
  | sed -E 's/.*(微信|支付宝|Stripe).*/\1/' | sort | uniq -c
```

#### 4.1b 是验签失败还是后续失败

```bash
# 微信：看关键字
docker logs ruidong-console-api --since 30m 2>&1 | grep -E '微信回调.*(签名|verifySign|缺少必需 header)' | tail -10

# 支付宝：
docker logs ruidong-console-api --since 30m 2>&1 | grep '支付宝验签失败' | tail -10

# Stripe：
docker logs ruidong-console-api --since 30m 2>&1 | grep 'Stripe webhook 处理失败' | tail -10
```

若是验签失败 → 跳 5.3（配置问题）。

#### 4.1c Redis 幂等保护是不是把真回调也当 replay 丢了

```bash
# 支付宝 notify_id 样例键
docker exec ruidong-redis redis-cli --scan --pattern 'payment:notify:alipay:*' --count 100 | head
docker exec ruidong-redis redis-cli --scan --pattern 'payment:notify:wechat:*' --count 100 | head
# 看 TTL（正常应该是若干分钟）
docker exec ruidong-redis redis-cli TTL 'payment:notify:alipay:<notify_id>'
```

如果这些键数量不合理（比如 TTL 被设成 1 天导致真重放都当 replay），跳 5.4。

#### 4.1d 后续写库失败

如果验签过了但 `handlePaymentCallback` 里报错：

```bash
docker logs ruidong-console-api --since 30m 2>&1 | grep -E 'handlePaymentCallback|Order.*update.*fail|Prisma' | tail -20
```

可能原因：PG 问题（→ `db-down-or-slow.md`）、Prisma schema drift、唯一约束冲突（并发）。

### 4.2 订单状态没更新到 `PAID`

```bash
# 找一个典型卡住的订单（用户上报的 out_trade_no 是 Order.id）
docker exec ruidong-postgres psql -U ruidong -d ruidong_console_saas <<SQL
SELECT id, user_id, channel, status, trade_no, paid_at, created_at, idempotency_key
FROM "Order"
WHERE id = '<ORDER_ID>';
-- 查审计日志
SELECT action, before_status, after_status, created_at, reason
FROM "OrderAuditLog"
WHERE order_id = '<ORDER_ID>'
ORDER BY created_at;
SQL
```

- `status = PENDING` 且 `trade_no IS NULL` → 回调没进来，跳 4.4
- `status = PENDING` 且 `trade_no` 有值 → 走到 `handlePaymentCallback` 但失败中途回滚，跳 4.1d
- `status = PAID` 但用户说没到账 → 发货逻辑问题，不在本 runbook，找业务 owner

### 4.3 Outbound `integration-webhook` 积压（1B）

```bash
# 队列计数
docker exec ruidong-redis redis-cli <<'CMDS'
LLEN bull:integration-webhook:wait
LLEN bull:integration-webhook:active
ZCARD bull:integration-webhook:delayed
ZCARD bull:integration-webhook:failed
CMDS

# 看失败 job 详情（取一个）
docker exec ruidong-redis redis-cli ZRANGE bull:integration-webhook:failed 0 5 WITHSCORES
docker exec ruidong-redis redis-cli HGETALL bull:integration-webhook:<JOB_ID>
```

常见原因：
- 下游端点 5xx/超时（`webhook.processor.ts` 会重试）
- SSRF guard 命中 → `UnrecoverableError`，不会重试（正确行为）
- 下游 4xx → `UnrecoverableError`，也不会重试

查日志：
```bash
docker logs ruidong-console-api --since 30m 2>&1 | grep -E 'WebhookProcessor|\\[.*\\] (delivered|retrying|4xx)' | tail -30
```

### 4.4 回调根本没到 API

```bash
# Nginx 访问日志是否有请求
sudo tail -n 1000 /var/log/nginx/access.log | grep '/api/payment/notify/' | awk '{print $7, $9}' | sort | uniq -c | tail

# Nginx 错误日志
sudo tail -n 200 /var/log/nginx/error.log

# DNS / 证书（provider 必须能 resolve + 信任证书）
dig +short api.your-domain.com
openssl s_client -connect api.your-domain.com:443 -servername api.your-domain.com </dev/null 2>&1 | openssl x509 -noout -dates
```

如果 provider 那边显示"连接失败" → 跳 `cert-expiring.md` 或检查 ALB 健康。

---

## 5. 修复 Playbook

> **统一规则**：任何动资金或订单状态的操作前，先在事故频道贴出 **当前订单样本 + 将要执行的命令**，lead 确认后再动。

### 5.1 回调积压的"正确重放"流程（禁止盲重试）

**本来的状态**：一批订单卡在 PENDING，provider 侧显示已成功。

**分三步，顺序不可改**：

**Step 1：列出可疑订单集合**
```sql
-- 事故窗口内 PENDING 超过 10 分钟的订单
SELECT id, user_id, channel, amount_cents, trade_no, created_at
FROM "Order"
WHERE status = 'PENDING'
  AND created_at BETWEEN '<incident_start>' AND '<incident_end>'
  AND created_at < now() - interval '10 minutes'
ORDER BY created_at;
```
导出到 CSV 存档。

**Step 2：对账（provider 查单，不是本地重试）**
对每个订单调 provider 的查单 API（这是本地 payment service 已有的能力；如果没有对账服务，临时脚本，不要手点 provider 后台）：
- 微信：`wechat-pay.service` 的查单接口
- 支付宝：`alipay.service` 的 `tradeQuery`
- Stripe：`stripe.paymentIntents.retrieve`

把结果落在一张表：`order_id | local_status | provider_status | provider_trade_no | amount`

**Step 3：按对账结果单条补单**

- provider = 未支付 → 本地保持 PENDING，无需动作（让正常超时流程走）
- provider = 已支付 AND local = PENDING → **用 `handlePaymentCallback` 的幂等接口**（`Order.idempotencyKey` + `trade_no` 唯一约束会保护不重复入账）
  ```bash
  # 调内部 admin 接口 / 或通过 psql 记一条 audit 后手动触发（由 lead 操作）
  ```
- provider = 已退款 / 失败 → 对应本地状态流转为 FAILED，**不补发货**

**严禁的操作**：
- 批量把 PENDING 改成 PAID 的 SQL
- 在 provider 后台点"重新推送通知"让一批全部走回来（会跟 5.2 相互踩）
- 重启 API 来"试试看能不能自动好"

### 5.2 临时增加 replay 保护 TTL（事故期间）

如果怀疑某个 provider 在事故期间发了大量重复通知，临时把 Redis 幂等键 TTL 延长：
```bash
# 具体改在代码层更稳妥；事故期间可以通过 provider 后台暂停推送、对账后再打开
```

### 5.3 验签失败（配置问题）

**本来的状态**：100% 回调验签失败。

**执行**：
1. 确认密钥类配置没被动过：
   ```bash
   docker exec ruidong-console-api sh -c 'env | grep -E "WECHAT_|ALIPAY_|STRIPE_" | grep -v KEY' # 看 path / client id
   ```
2. 检查 `fastify-raw-body` 注册（微信和 Stripe 必需）：
   ```bash
   docker logs ruidong-console-api 2>&1 | grep -i 'raw-body\|rawBody' | tail
   ```
   如果启动日志看不到 raw-body 初始化 → 上次部署改坏了，回滚：
   ```bash
   cd /opt/ruidong/codesphere-admin-saas
   git log --oneline -20
   # 找到上个稳定 commit，回滚
   git checkout <prev_commit> -- apps/api/src/main.ts  # 或全仓回滚
   docker compose -f docker-compose.prod.yml up -d --build api
   ```
3. Stripe 特别注意：`STRIPE_WEBHOOK_SECRET` 是每个 endpoint 一个，换 endpoint 后忘记更新是常见坑。

**怎么确认恢复**：挑一笔测试订单（最小金额 0.01 元微信/支付宝，或 Stripe test mode），端到端跑通。

### 5.4 幂等键 TTL 配置错误（把真回调当成 replay）

**执行**：
1. 短期：把 provider 侧的异步通知触发一次（只挑一个订单验证）
2. 长期：代码层调整 TTL，加上监控"已 SUCCESS 回调但订单仍 PENDING"的告警

### 5.5 Outbound webhook 积压（1B）处理

**清理 failed 队列前必须知道：**
- failed job 不是"丢失"，是明确 4xx 或 SSRF 阻断。大部分不应重放。

**分类处理**：
```bash
# 抽样 failed 看失败原因
docker exec ruidong-redis redis-cli ZRANGE bull:integration-webhook:failed 0 10 WITHSCORES
# 逐个 HGETALL 看 failedReason
```

- 失败原因是下游临时 5xx → 可以考虑 retry（走代码里的 requeue 接口，不要直接 LPUSH）
- 失败原因是 4xx / SSRF → **丢弃是正确行为**，不重放

短期止血：如果队列被 5xx 失败塞满且 worker 一直在退避，可临时暂停新事件入队（调管理接口），先把积压跑完。

---

## 6. 升级路径

| 触发 | 升级 | 动作 |
|------|------|------|
| 5 分钟 | 确认回调全线失败（任一 provider）→ 默认 P0 | 飞书 @backend-lead @业务线负责人；支付团队到岗 |
| 15 分钟 | 仍未恢复，积压 > 100 笔 | 通知产品发公告；客服准备话术（"已知支付到账延迟，无需重付"） |
| 30 分钟 | 对账发现疑似资损（本地 PAID 次数 > provider SUCCESS 次数） | 财务团队接入；启动补偿 / 退款流程；冻结相关路径直到对账完成 |

money path 默认抄送：业务 lead + 财务对接人 + 后端 lead。

---

## 7. 事后

### 事后必做（money path 强制）

- [ ] **对账报告**：事故窗口内 provider 已成功 vs 本地 PAID vs 本地 PENDING 三方对齐，每条订单状态最终落定
- [ ] **资损核算**：如果存在本地 PAID 但 provider 未成功（或反之），计算金额、写入 post-mortem
- [ ] **用户通知**：误收费或发货失败的用户必须主动联系
- [ ] **post-mortem**：用 `docs/templates/post-mortem.md`，money path 评审必须有 lead + 财务参与

### 监控补齐

- [ ] **Sentry alert**：`notify.*处理失败` 1 分钟 > 5 → 立即 page
- [ ] **PG 业务告警**：`Order.status='PENDING' AND created_at < now() - 10m` 数量 > 20 → P1
- [ ] **Prometheus 指标**（Phase 5 T-10.4 落地后）：
  - `payment_notify_total{provider, result}` counter
  - `payment_notify_duration_seconds{provider}` histogram
  - `bullmq_queue_size{queue="integration-webhook", state}` gauge
- [ ] **对账定时任务**：每 10 分钟扫一次 PENDING > 10 min 的订单，自动走 provider 查单 + 补单（用幂等接口）

### 测试补齐

- [ ] 端到端测试：microapp 真 SDK 在 CI 里 mock provider 回调，覆盖验签 + replay + 数据库写
- [ ] 单元测试：`handlePaymentCallback` 在 Redis 挂、PG 事务失败、重复回调三种情况下的幂等
- [ ] 混沌测试：staging 把 Redis 手动停掉，看 replay 保护降级行为
- [ ] 负载测试：100 并发回调打进来，pool / 锁 是否撑得住

### 架构动作

- [ ] 评估把入站回调也走 BullMQ：收到 → 验签 → 立即 ACK 返回 provider → 异步处理业务。好处：provider 不会因为业务慢而重试；坏处：多一层复杂度，幂等更难
- [ ] 为三个 provider 统一抽出 `NotifyProcessor` 抽象，集中幂等和 replay 逻辑
- [ ] 对账服务独立成服务或定时任务（目前缺失）

---

**Post-mortem 模板**：`docs/templates/post-mortem.md`
**相关 runbook**：`db-down-or-slow.md`、`redis-down.md`、`5xx-spike.md`、`cert-expiring.md`
**相关代码**：
- `apps/api/src/payment/payment.controller.ts`（notify endpoints）
- `apps/api/src/payment/payment.service.ts`（`handlePaymentCallback` / `handleStripeEvent`）
- `apps/api/src/integration/webhook/`（outbound queue）
