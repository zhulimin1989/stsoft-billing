# quota/bonus 权威余额 V2 上线手册

## 目标与边界

- PostgreSQL `credit_balance_states` 是 quota/bonus 唯一真值。
- Redis `credits:v2:{subscriptionId}` 只是带 version 的缓存。
- 换档抵扣、用量授权和默认额度发放等资金/权益决策直接读取 PostgreSQL；展示读取可使用 Redis。
- state 的 `user_id` 是订阅作用域 owner；`CreditTransaction.user_id` 是本次交易 actor。租户成员可以消费 owner 的共享订阅余额。
- GRANT 奖励池仍沿用独立的 Redis reservation + PostgreSQL redemption 协议。
- 本次不修改支付币种或钱包货币逻辑。

## 为什么不能混跑旧、新资金协议

旧版本会直接修改两个 V1 Redis key，再补写 `CreditTransaction`；新版本会先修改
PostgreSQL state，再通过版本化 Outbox 投影 Redis。若同一个 subscription 同时进入两种
协议，旧版本无法更新 state，仍可能制造余额分叉。

因此生产切换必须满足其一：

1. 短时停止 quota/bonus 的发放、重置、退款和扣减，完成全量滚动后恢复；或
2. 网关按 subscription 做稳定、全链路路由，确保同一 subscription 的 HTTP、Kafka、
   webhook 和管理员操作全部进入同一版本。无法保证全链路粘性时必须使用方案 1。

## 上线步骤

1. 备份 `credit_transactions`，记录旧 Redis quota/bonus key 的快照。
2. 部署 additive migration，但暂不切换应用实例。
3. 只读运行：

   ```bash
   export BILLING_DATABASE_URL='postgresql://.../billing'
   export REDIS_HOST='billing-redis.internal'
   export REDIS_PORT='6379'
   # 按环境设置 REDIS_PASSWORD / REDIS_TLS；脚本不会自动加载 .env。
   pnpm --filter @ruidong/api credit:backfill-balance-state
   ```

   只修复已批准的特定 scope 时，必须使用显式 allowlist；脚本将完全跳过全库和 Redis
   keyspace 扫描，只审计列出的 scope，但仍执行相同的 owner、完整流水重放、旧 Redis
   终值和已有 state 校验：

   ```bash
   export BILLING_CREDIT_BALANCE_BACKFILL_SCOPE_IDS='subscription-id-1,subscription-id-2'
   pnpm --filter @ruidong/api credit:backfill-balance-state
   ```

   设置了变量却为空、或列表包含空项时脚本会拒绝运行，不会静默退回全量模式。
   dry-run 输出必须显示 `mode=targeted`，且 `requestedScopeIds`、
   `requestedScopeCount`、`verified` 和审批范围完全一致，`isolated=0`，才能进入定向
   apply。

4. 脚本会按完整流水状态机重放，而不是信任“最新 after 快照”。只有“重放终值、旧 Redis、
   已有 state（若有）”三方一致的记录才可自动回填。所有 `REPLAY_*`、`CACHE_*`、
   `SCOPE_OWNER_*`、`EXISTING_STATE_MISMATCH` 均进入人工隔离，且脚本以退出码 2 结束。
   不得自动选择 DB 或 Redis 覆盖。

   历史 `CONSUME` 没有保存 `fromGrant`，因此凡是需要推断 grant 分摊的作用域会以
   `REPLAY_GRANT_ALLOCATION_UNVERIFIABLE` 隔离；这项保守限制也能避免把冷缓存竞态产生的
   重复 after 快照误当成 grant 消费。人工核对时需结合 GrantRedemption 和业务流水。

   `CACHE_MISSING` 同样不会自动回填；已有流水但没有 state 的订阅在 V2 下会安全拒绝
   余额读写与 Publisher 放行，必须先完成人工核对和 state 初始化。
   只有旧 Redis 余额、没有流水的作用域会以 `MISSING_OPENING_HISTORY` 隔离，运行时也不会
   自动初始化为 0。

   默认单作用域最多重放 50,000 条流水，超过时以 `HISTORY_TOO_LARGE` 隔离，避免脚本 OOM。
   可在评估内存后通过 `BILLING_CREDIT_BALANCE_BACKFILL_MAX_TX_PER_SCOPE` 调整；超大账户应使用
   专门的分页审计流程，不得为了通过上线直接提高到无界值。
5. 暂停资金变更流量，再执行已验证记录回填：

   ```bash
   APPLY=true \
   BILLING_CREDIT_BALANCE_BACKFILL_ASSUME_QUIESCED=true \
   BILLING_CREDIT_BALANCE_BACKFILL_ALLOW_FULL_APPLY=true \
   BILLING_DATABASE_URL='postgresql://.../billing' \
   REDIS_HOST='billing-redis.internal' \
   REDIS_PORT='6379' \
   pnpm --filter @ruidong/api credit:backfill-balance-state
   ```

   全量 apply 的额外授权变量只接受精确值 `true`；缺失时脚本会拒绝全量写入。定向
   apply 不设置该变量，避免 allowlist 漏传时退回全量写。

   定向 apply 必须复用已审批 dry-run 的完全相同 allowlist：

   ```bash
   APPLY=true \
   BILLING_CREDIT_BALANCE_BACKFILL_ASSUME_QUIESCED=true \
   BILLING_CREDIT_BALANCE_BACKFILL_SCOPE_IDS='subscription-id-1,subscription-id-2' \
   BILLING_DATABASE_URL='postgresql://.../billing' \
   REDIS_HOST='billing-redis.internal' \
   REDIS_PORT='6379' \
   pnpm --filter @ruidong/api credit:backfill-balance-state
   ```

6. 更新全部 billing-api 实例，确认旧实例为 0 后恢复流量。
7. 确认 `BILLING_CREDIT_BALANCE_OUTBOX_ENABLED=true`。
8. 观察至少一个业务高峰，再执行 Redis restart/eviction 演练。

## 上线检查

- 幂等重放没有新增余额 state version、流水或 Outbox。
- `credit_balance_outbox` 没有持续 `FAILED/RUNNING/MANUAL_REVIEW` 积压；成功投影使用带
  claim token 的 fencing delete 立即移除，不会随用量永久增长。
- 普通网络/Redis 故障保持 `FAILED` 并无限封顶退避，`maxAttempts` 是告警阈值而不是停止阈值；
  只有缓存同版本冲突、损坏或版本超前于 PostgreSQL 才进入 `MANUAL_REVIEW`。
- 不存在相同 `(subscription_id, version)` 的不同余额。
- Redis version 不高于 PostgreSQL state version，最终与 state 相等。
- 成功扣减数与新增 `CONSUME` 流水数一致。
- PostgreSQL 行锁等待、事务错误率和 p95/p99 延迟在预算内。

## 回滚

- migration 为 additive，不删除新表或字段。
- 已进入 V2 的 subscription 不得直接回到 Redis-first 旧代码。
- 若 Redis/Outbox 异常，保留 PostgreSQL 权威写入并临时允许读直接回源数据库。
- 若数据库路径异常，先停止资金变更并排空请求，再修复或部署 V2 代码补丁；不能用旧
  Redis 快照继续授权消费。
- 幂等重放的历史快照回填逻辑不得恢复。
