# 个人负余额与充值批次账本修复上线手册（2026-07-15）

## 1. 变更目标与范围

本次修复保留个人账户负余额入口。要解决的根因是：账户进入负余额后，后续充值中用于偿还欠款的金额曾同时留在充值批次，导致账户钱包、批次剩余金额和充值明细不守恒。

本次只交付以下闭环：

- 个人负余额按不可变 `NEGATIVE_BALANCE` allocation 记账，后续入金按 FIFO 核销欠款；用于核销欠款的金额不再生成可消费批次余额。
- 钱包、充值批次、消费 allocation、欠款 settlement 和交易尾部在同一个账户级账本契约下守恒。
- 过期按账户执行：锁定账户的钱包、全部批次和账户后，一次性处理该账户所有到期批次；任一批次或账本事实异常则整账户回滚。
- 充值退款明确区分 `PAID` 与 `BONUS`，任务和不可变订单事实不一致时 fail closed。
- BALANCE 发奖入口在任何 redemption、钱包、批次或交易写入前 fail closed；历史 `GRANT_RULE` 只进入 quarantine，原因是 `FUNDING_GRANT_RULE_DEFERRED`。

下列内容明确不在本次设计范围：发奖模型、推荐奖励、CREDIT 账本或冲正、发票业务流程。不得借本次上线改造这些模块。repair 不推断、不修改发票业务事实；只有显式启用受审 profile，且数据库生成的订单、申请、明细、事件闭包完整稳定时，才允许把不可变发票快照作为“账本 repair 不会破坏发票”的证明。证据缺失、非法或漂移时仍必须隔离。发票业务能力需要后续单独设计、单独评审和单独上线。

## 2. 财务不变量

所有金额使用 `DECIMAL(20,12)` 精确比较，不设置误差容忍。对 `RECONCILED_V2` 账户必须始终满足：

```text
wallet balance
  = 所有未过期批次 remaining_amount 之和
  - 所有未结清 NEGATIVE_BALANCE allocation 之和

grant.remaining_amount
  = grant.remaining_paid_amount
  + grant.remaining_bonus_amount

每笔 CONSUME transaction 金额的绝对值
  = 同笔 transaction 全部 allocation 的精确合计

交易序列逐笔衔接，最后一笔 balance_after
  = 当前 wallet balance
```

行为约束：

- 个人扣费允许把钱包扣成负数；负数必须有同额的 open debt allocation。
- 后续入金先清偿 open debt，再把净剩余金额放入新批次。
- `PAID` 只核销 paid component，`BONUS` 只核销 bonus component；两者不能相互冒充。
- 缓存只是数据库已提交账本的投影，不是财务事实来源。写后投影必须重新读取当前绑定和当前数据库余额，不能用旧事务快照覆盖新余额。
- 财务事务统一使用取得钱包锁后的数据库 `financialNow`；应用服务器时钟不得决定批次是否到期。

## 3. 截图问题的强制验收

必须在隔离 PostgreSQL 中按顺序执行完整业务入口，不允许直接改表模拟：

| 顺序 | 操作 | 账户余额 | 充值批次预期 |
| --- | --- | ---: | --- |
| 1 | 充值 `+1.00` | `1.00` | 第一批 remaining `1.00` |
| 2 | 使用 `-1.34` | `-0.34` | 第一批 remaining `0.00`，open debt `0.34` |
| 3 | 充值 `+5.00` | `4.66` | 先核销 debt `0.34`，第二批 remaining `4.66` |
| 4 | 使用 `-4.66` | `0.00` | 第二批 remaining `0.00` |
| 5 | 充值 `+5.00` | `5.00` | 第三批 remaining `5.00` |
| 6 | 使用 `-5.14` | `-0.14` | 第三批 remaining `0.00`，open debt `0.14` |

最终必须同时满足：

- 账户可用余额：`-0.14`；
- 累计充值本金：`11.00`；
- 三个充值批次 remaining 都是 `0.00`，状态均为已用完；
- public `getCreditsSummary` 与 `getCreditDetails` 返回上述同一事实；
- 不存在可再次消费的 `0.34`，也不存在把负余额显示成批次正余额的情况。

任何一项不一致都视为修复未完成，不得上线。

## 4. 发布物与两阶段边界

Release A 是正常 Prisma migration，只扩展兼容结构、安装审计/序列/准备函数，并把 durable phase 置为 `EXPANDED`：

```text
20260715000100_personal_negative_balance_settlement
20260715000101_billing_account_ledger_status_index
20260715000102_enterprise_settlement_balance_grant_index
20260715000103_enterprise_settlement_account_source_index
20260715000104_enterprise_settlement_repair_run_index
20260715000110_balance_allocation_ledger_sequence_unique
20260715000120_balance_transaction_operation_key_unique
20260715000130_enterprise_settlement_operation_key_unique
20260716000250_refund_compensation_component_backfill
20260716000251_refund_compensation_component_contract_comment
20260716000300_balance_transaction_ledger_sequence_unique
20260716000310_balance_financial_clock_floor_index
20260716000320_balance_allocation_ledger_sequence_insert_guard
20260717000100_balance_legacy_financial_proof_contract
20260717000110_enterprise_absorb_pair_repair_contract
20260717000120_balance_debt_settlement_legacy_timing_contract
20260718000100_balance_migration_opening_retirement_contract
20260718000200_legacy_personal_overdraw_voucher_proof_contract
20260722000100_hk_legacy_expiry_invoice_evidence_contract
```

最后三条 migration 都只安装 repair 契约，不会生成计划，也不会自动修改任何账户：

- `20260718000100` 保存旧 `MIGRATION_OPENING` 伪批次的退休审计、删除保护和终态校验。只有能够逐字段证明为旧 writer 固定形状、且唯一 allocation 已在同一受审 repair 中改写为 `NEGATIVE_BALANCE` 的伪批次，才允许在账户最终晋升 `RECONCILED_V2` 的同一事务中退休。
- `20260718000200` 保存旧个人跨零消费的 `SPLIT/RECLASS` 证明，以及旧代金券 writer 的 `PRE_IDEMPOTENCY/FULL_REMAINDER_DEBT_ABSORPTION` 证明。它不伪造 idempotency receipt、不修改代金券交易或批次 gross 金额，也不开放通用手工分摊入口；完整证据、双审批或终态守恒任一缺失时整账户回滚。
- `20260722000100` 安装按目标账户动态生成的发票订单、申请、明细、事件闭包及 SHA-256，保存 append-only 稳定性证明，并在插入和终态阶段重新计算校验。目录名保留历史 UAT 来源，但 SQL 不绑定数据库名或账户 ID，可供任何完成该迁移的环境使用。

尽管这些文件日期晚于 Release B rollout 文件，它们仍是 Release A 的正常 Prisma migration，必须随同一不可变目标镜像完成安装。新契约同时兼容尚未 contract 的 `EXPANDED/CUTOVER_READY` 和已 contract 的 `V2_CONTRACT` 环境；真正 proof 写入仍只允许 `RUNNING` repair 中的 `LEGACY_DIRTY` 账户。

Release B 是独立 contract rollout，绝不能放进 Prisma migration 目录或随 Release A 自动执行：

```text
apps/api/prisma/rollouts/20260717000100_balance_expiry_v2_contract/migration.sql
```

Release B 在一个事务内完成 gate 重检、表锁、15 个 strict trigger 安装以及 `CUTOVER_READY -> V2_CONTRACT` compare-and-swap。任何一步失败，事务必须整体回滚。

## 5. 上线前硬门禁

本次合并前必须确认 GitHub Actions 变量
`BILLING_LEDGER_V2_AUTODEPLOY` 不等于 `enabled`。该门禁让普通 `main/test`
push 只构建和验证镜像，不会自动在目标库执行 Release A 后立即拉起 writer。
Release A、Release B 和 writer 恢复必须按本 runbook 人工执行；目标库确认
`V2_CONTRACT` 且第 10 节恢复门禁全部通过后，才可把变量设为 `enabled`
恢复日常自动部署。

### 5.1 环境与权限

先在与生产 PostgreSQL major version 完全一致的生产克隆演练。Release A 的 migration role 必须能调用 `pg_control_system()`；在执行任何 DDL 前验证：

```sql
SELECT current_database() AS database_name,
       (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid,
       system_identifier
FROM pg_control_system();
```

查询失败或身份信息与审批环境不一致时立即停止。不得临时绕开 `pg_control_system()` preflight，也不得用数据库名相同来替代 cluster system identifier、database OID 和随机 `database_identity` 的联合绑定。

执行已失败 migration 的 `resolve/replay` 前原则上必须取得并验证数据库快照。只有明确标识为非生产的测试环境，才允许由负责人书面豁免；证据必须记录环境、审批人、时间、豁免原因和“不得沿用到生产”。即使已豁免，后续第 5.4 节的 checksum、partial fingerprint、writer drain、单实例无重试门禁均不得放宽。

### 5.2 Writer drain

以下 writer 必须暂停并确认所有 in-flight 为 0：

- 批次过期 worker；
- 充值、赠额、代金券、人工调额等会增加钱包或创建批次的入口；
- 同步充值退款入口和 refund-compensation worker；
- BALANCE 发奖任务。
- 新建个人/企业账务账户及 tenant attach/detach/rebind 入口。

普通消费扣费和个人负余额入口保持开启。Release A 的 bridge 只允许新序列化的 `CONSUME`；若出现新的 `RECHARGE`、`ADJUST` 或 `REFUND`，CUTOVER gate 会拒绝继续。

退款任务必须满足：

```sql
SELECT COUNT(*) AS running_refund_balance
FROM refund_compensation_tasks
WHERE action = 'REFUND_BALANCE'
  AND status = 'RUNNING';
```

结果必须为 `0`。保留逐行清单、worker 实例数和 drain 时间作为审批证据。

### 5.3 到期存量批次硬停止

Release B 前不得存在已到期或将在 safety horizon 内到期、且 remaining 为正的存量批次。特别是 `LEGACY_DIRTY` 账户的到期批次不能由新 worker 自动过期：

```sql
SELECT g.billing_account_id,
       g.id AS grant_id,
       g.remaining_amount_usd,
       g.expires_at,
       a.balance_grant_ledger_status
FROM balance_grants g
JOIN billing_accounts a ON a.id = g.billing_account_id
WHERE g.is_expired = FALSE
  AND g.remaining_amount_usd > 0
  AND g.expires_at IS NOT NULL
  AND g.expires_at <= :'expiry_safe_through'::timestamp(3)
ORDER BY g.expires_at, g.billing_account_id, g.id;
```

必须返回 `0` 行。只要存在 due legacy grant 就硬停止：不得直接把 `is_expired` 改为 true，不得补写 `ADJUST` 假装过期，也不得缩短 safety horizon 规避门禁。存量到期策略需另开财务方案，经证明后再生成 repair 计划。

### 5.4 PostgreSQL 18 失败迁移恢复分支

`20260715000100_personal_negative_balance_settlement` 已发布过两个内容版本：

```text
old / PostgreSQL 18 失败 checksum:
0fbbce8db89f7ffe03b68c5a7e0b60375a22b246c335d32cdbae25588c3f1a7a

current / PostgreSQL 16-18 兼容 checksum:
ead494351c7e71fd1d7e5b2d180f419abd044ed41f3ad6306c6598e9b13f75b9
```

旧文件在 PostgreSQL 18 上把 `pg_constraint.contype = 'n'` 的列级 NOT NULL 目录表达重复计入约束指纹，因而在多段 DDL 已提交后失败。NOT NULL 真值已经由 column fingerprint 的 `pg_attribute.attnotnull` 验证；current 文件只排除重复目录表达，不改变业务约束。

恢复前必须只读核验，且只能进入以下三个分支之一。

1. **已成功终态**：同名 migration 已有 `finished_at IS NOT NULL` 的记录。禁止 `resolve`、禁止重放；正常 `migrate deploy` 只继续后续 migration。已成功执行 old checksum 的 PostgreSQL 16 环境不会被 production `migrate deploy` 阻断，但 drift/status 工具可能把历史文件变化报告为 modified migration，必须登记为本次审批过的审计例外。
2. **唯一可重放状态**：同名 migration 的总记录数必须恰好为 1，且这一条就是未完成记录；checksum 必须为 old checksum，`finished_at`/`rolled_back_at` 均为空、`applied_steps_count = 0`；rollout control、transition、identity rotation 均为 0 行；`prepare_balance_ledger_v2_contract` 不存在；Release B strict trigger 为 0；下表所有 partial fingerprint 精确匹配。只有这一分支允许先 `--rolled-back`，再以 current checksum 的同一不可变镜像执行一次 `migrate deploy`。
3. **SQL 已完成但 Prisma 未终态，或其他状态**：若 durable control/terminal audit 已存在，禁止重放；只有在完整 catalog、locator 和 transition 证明 SQL 已完成后，才可审批 `migrate resolve --applied`。任何 checksum、行数、fingerprint、phase 或 locator 不匹配都必须停止，由新的财务恢复方案处理，不能猜测或自动 fallback。

唯一可重放状态的精确指纹：

| catalog | count | MD5 fingerprint |
| --- | ---: | --- |
| columns/tables | 129 | `046130cfdf51df9b0d0788cea7dc8856` |
| indexes | 12 | `eb7432785384bf74e1f88136b02960d2` |
| constraints（PG18 含 `contype='n'`） | 158 | `9b9c2b694396bc38366c981f150dd883` |
| constraints（排除重复 NOT NULL 表达） | 58 | `f4db5b9cdda51b5472adf28bb6b87bf9` |
| functions（prepare 尚未创建） | 44 | `648193b14237e0048684c89c9bc8a3e8` |
| triggers | 33 | `a3150379d31ba4c6da8d299bf8c52ba6` |
| sequences | 2 | `626d64525a2d2dcb50ae9a675017121e` |

以下两份只读 verifier 既用于 CI 重演，也是目标环境恢复 Job 的强制门禁，禁止用手工摘抄查询替代：

```text
apps/api/prisma/recovery/20260715000100_personal_negative_balance_settlement/verify-pg18-partial.sql
apps/api/prisma/recovery/20260715000100_personal_negative_balance_settlement/verify-recovered.sql
```

通过门禁后，恢复 Job 必须 `completions=1`、`parallelism=1`、`backoffLimit=0`，且固定 current checksum 对应的 image digest。Job 必须用单个 `/bin/sh -c` 执行以下完整代码块，使 shell 选项覆盖全部四步：

```bash
set -euo pipefail

: "${BILLING_DATABASE_URL:?BILLING_DATABASE_URL is required}"
export DATABASE_URL="$BILLING_DATABASE_URL"
cd /app/apps/api

pnpm exec prisma db execute \
  --file prisma/recovery/20260715000100_personal_negative_balance_settlement/verify-pg18-partial.sql \
  --url "$DATABASE_URL"

pnpm exec prisma migrate resolve \
  --rolled-back 20260715000100_personal_negative_balance_settlement \
  --schema=prisma/schema.prisma

pnpm exec prisma migrate deploy --schema=prisma/schema.prisma

pnpm exec prisma db execute \
  --file prisma/recovery/20260715000100_personal_negative_balance_settlement/verify-recovered.sql \
  --url "$DATABASE_URL"
```

第一个 verifier 必须在 `resolve` 之前通过；`set -euo pipefail` 必须确保任何一步非零都立即终止，不能依赖 `backoffLimit=0` 代替命令短路。第二个 verifier 必须在 `migrate deploy` 之后通过，否则 Job 必须失败且保持 writers drain。四步必须在同一容器、同一 `/app/apps/api` 工作目录中执行，并由同一个已校验非空的 `BILLING_DATABASE_URL` 导出唯一的 `DATABASE_URL`；不得让 verifier 与 migrate 从不同连接变量取值。不得把以上四步拆给不同镜像，不得在失败后自动再次执行 `resolve`。成功后必须证明：old checksum 行已 `rolled_back_at IS NOT NULL`，current checksum 新行已 `finished_at IS NOT NULL` 且 `applied_steps_count = 1`，全库无 unresolved migration，phase 为 `EXPANDED`，rollout control 全表恰好一行，只存在一条 `NOT_INSTALLED -> EXPANDED` transition，prepare function 恰好一个，Release B strict trigger 仍为 0。

## 6. Release A 执行与检查

1. 保持第 5.2 节 writer drain，执行正常的 `prisma migrate deploy`。
2. 每个 `CREATE INDEX CONCURRENTLY` migration 必须单独成功；检查同名索引 `indisready=true AND indisvalid=true`。失败索引不得用 `IF NOT EXISTS` 掩盖。
3. 检查 durable control 与数据库身份：

```sql
SELECT phase,
       database_name,
       database_identity,
       database_system_identifier,
       database_oid,
       expanded_at,
       opening_grant_count_at_expand
FROM balance_ledger_rollout_control
WHERE id = 1;
```

`phase` 必须是 `EXPANDED`，且 locator 与第 5.1 节一致。

4. 用 Release B 的完整 trigger 名单检查 strict trigger 数量，此时必须为 `0`：

```sql
SELECT COUNT(*) AS strict_trigger_count
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname IN (
    'balance_grants_expiry_reconciled_v2_guard',
    'balance_grants_expiry_aggregate_deferred',
    'account_wallets_clean_canonical_deferred',
    'balance_grants_clean_canonical_deferred',
    'balance_debt_allocations_clean_canonical_deferred',
    'balance_transactions_clean_canonical_deferred',
    'balance_canonical_revision_marker',
    'balance_consumption_allocations_identity_guard',
    'account_wallets_identity_guard',
    'billing_accounts_clean_type_guard',
    'balance_grant_refunds_canonical_deferred',
    'balance_grant_refund_allocations_canonical_deferred'
  );
```

同名 `balance_canonical_revision_marker` 分别安装在四张表上，所以 Release B 完成后的总数是 15，不是 trigger 名称去重后的 12。

### 6.1 V2 镜像切换与旧实例排空

Release A 检查通过后、执行 `prepare_balance_ledger_v2_contract` 前，必须先把全部 Billing 流量切换到本次 V2 镜像。`BILLING_LEDGER_V2_AUTODEPLOY` 仍保持不等于 `enabled`，使用审批过的 Git SHA 镜像标签手工只部署 `billing-api`；本步骤不得再次运行 `billing-db-migrate`，也不得提前执行 Release B。例如测试环境使用 ops 仓库的受控部署入口：

```bash
scripts/deploy-test-images.sh \
  --billing-tag '<approved-git-sha>' \
  billing-api
```

部署期间第 5.2 节列出的增额、退款、过期、BALANCE 发奖和账户绑定类 writer 必须持续 drain。个人负余额和普通消费入口保持开启，但只能逐步接入已通过健康检查的 V2 实例。每个旧实例必须先从负载均衡摘除，再等待其所有请求（包括 debit）和数据库事务完成，最后终止；不得直接杀死仍在处理财务事务的实例。

完成滚动切换后必须同时验证并留存原始证据：

- 当前运行的每个 billing-api/同镜像 worker 都使用审批 Git SHA 对应的同一个不可变 image digest，不能以 `test-latest` 标签值作为证据；
- 旧 digest 的 Pod、容器和 worker 数量均为 `0`；
- 旧实例的连接、in-flight request 和 in-flight debit 均为 `0`，且已完整等待负载均衡与进程 termination grace period；
- 新 V2 实例健康检查通过，实际承接的 Billing 流量中不存在旧版本实例；
- 第 5.2 节所有受控 writer 仍为 drain 状态，`RUNNING REFUND_BALANCE` 仍为 `0`，Release A phase 仍为 `EXPANDED`，strict trigger count 仍为 `0`。

任何运行实例的 digest 无法证明、旧实例未清零、旧 in-flight 无法证明为零，或 drain 期间出现非 `CONSUME` bridge 写入，都必须停止切换并保留 `EXPANDED`，不得调用 prepare 或执行 Release B。完成以上验证后，证据包中的“当前镜像 digest”必须记录实际运行 digest 及其 Git SHA 映射，而不是可移动标签。

## 7. CUTOVER gate 与 Release B

### 7.1 生成审批证据

证据包至少包含：

- V2 Git SHA 与实际运行 image digest 的映射、全部运行实例 digest 清单、旧 Billing Pod/worker 数量和旧 in-flight 数；
- writer drain 结果与 `RUNNING REFUND_BALANCE = 0`；
- due legacy 查询为 0；
- Release A migration、索引、phase 和 strict trigger count 结果；
- `database_name`、`database_identity`、system identifier、database OID；
- 隔离库测试结果和截图账户 dry-run 结果。

对证据包原始内容计算 SHA-256。审批人、工单号、摘要和 safety horizon 不得复用其他数据库的值。

### 7.2 准备 CUTOVER_READY

在 writer 仍保持 drain 时调用：

```sql
SELECT *
FROM prepare_balance_ledger_v2_contract(
  :'expected_database_name',
  :'expected_database_identity'::uuid,
  :'operator',
  :'change_ticket',
  :'evidence_sha256',
  :'expiry_safe_through'::timestamp(3)
);
```

`expiry_safe_through` 从调用时起至少覆盖 15 分钟，且必须覆盖预计 Release B 完成窗口。函数返回 `phase=CUTOVER_READY` 后，重新核对 locator、到期查询、opening grant count、bridge 非 CONSUME 数量和 strict trigger count。任何证据过期或重试都必须重新 prepare，不能手改 control 表。

### 7.3 执行 Release B

用 `psql -X -v ON_ERROR_STOP=1` 单独执行 Release B 文件。Release B 会按线上 writer 顺序取得并持有以下 SHARE table locks：

```text
account_wallets
balance_grants
billing_accounts
balance_transactions
balance_consumption_allocations
enterprise_credit_settlements
balance_grant_expiries
balance_grant_refunds
balance_grant_refund_allocations
```

这些锁关闭 gate 检查与 trigger 安装之间的 TOCTOU。`lock_timeout=5s`；超时说明仍有 writer 或长事务，必须停止、定位并重新 prepare，不得提高超时强行穿过。

完成后验证：

```sql
SELECT phase, v2_contract_at, database_identity
FROM balance_ledger_rollout_control
WHERE id = 1;
```

`phase` 必须为 `V2_CONTRACT`。再次运行第 6 节 trigger 查询，结果必须为 `15`。还必须验证 phase transition audit 只有合法的 `EXPANDED -> CUTOVER_READY -> V2_CONTRACT` 链。

## 8. 存量 repair

repair 只能在 `V2_CONTRACT` 上执行。每次先 dry-run，输出文件必须是新文件：

部署和 repair 是两个独立步骤：`prisma migrate deploy`、Release B、API 启动和 Argo 自动同步都不得隐式调用 `--apply`。目标库完成 Release A（包括 `20260718000100_balance_migration_opening_retirement_contract`）和独立 Release B、phase 验证为 `V2_CONTRACT` 后，才能由操作人对双人复核通过的计划显式执行受审 apply。

repair 排队必须按每个账户仍 active 且 remaining 为正的批次最早到期时间升序处理，即以 `MIN(expires_at)` 最小的账户优先；相同时间再按 `billing_account_id` 排序。候选清单使用以下固定口径生成：

```sql
SELECT g.billing_account_id,
       MIN(g.expires_at) AS next_expires_at
FROM balance_grants g
JOIN billing_accounts a ON a.id = g.billing_account_id
WHERE a.balance_grant_ledger_status = 'LEGACY_DIRTY'
  AND g.is_expired = FALSE
  AND g.remaining_amount_usd > 0
  AND g.expires_at IS NOT NULL
GROUP BY g.billing_account_id
ORDER BY next_expires_at ASC, g.billing_account_id ASC;
```

该排序只决定账户 repair 优先级，不得绕过逐账户 dry-run、计划 hash、双人复核或 stale snapshot 重验。

```bash
BILLING_DATABASE_URL='<billing-db-url>' \
pnpm --filter @ruidong/api balance:reconcile-ledger -- \
  --billing-account-id '<billing-account-id>' \
  --output-jsonl '<new-plan-path>'
```

dry-run manifest 必须同时绑定：

- `recordType=BALANCE_LEDGER_REPAIR_PLAN_V9`；旧 V1-V8 计划不得转换或沿用，必须由当前镜像在目标数据库重新 dry-run；
- `databaseName`；
- 随机 `databaseIdentity`；
- PostgreSQL `databaseSystemIdentifier`；
- `databaseOid`；
- 数据库 endpoint SHA-256；
- `phase=V2_CONTRACT`。

Plan V9 把 `migrationOpeningDebtMutations`、`personalDebtAllocationMutations`、`legacyVoucherProofMutations`、`legacyExpiryProofMutations` 和 `invoiceStabilityProof` 全部纳入严格字段校验与 `replayHash`；maintenance profile 位于严格解析的 manifest 中，由整个 plan 文件 SHA-256 和 apply 时的 exact profile match 绑定：

- `migrationOpeningDebtMutations` 只接受一个伪批次对应一个 allocation 的精确旧 writer 形状；
- `personalDebtAllocationMutations` 只接受一笔消费被唯一 `BALANCE_GRANT` allocation 错记的形状。跨零部分采用确定性 child ID 做 `LEGACY_DEBT_SPLIT_V1`，消费前余额已经不大于零时原行做 `LEGACY_DEBT_RECLASS_V1`。需要新增 child、但账户已有固定负序 allocation epoch 时必须 quarantine，不得为插槽重排历史序号；
- `legacyVoucherProofMutations` 只授权个人账户。`LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1` 必须证明发放前钱包恰好为零且没有 receipt；`LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1` 必须证明唯一 `COMMITTED` receipt 的其他字段全部精确、唯独旧 writer 把 remaining 记成 full amount，并且本次 voucher 的 hole fill 与同一 repair 退休的 `MIGRATION_OPENING` debt 逐 ID、逐金额闭合。

apply 必须在同一个 Serializable 账户事务中锁定并重建计划，写不可变 proof/audit，再执行 CAS allocation/grant 改写、确定性 child 插入、伪批次退休和 settlement，最后完成 postcondition、`APPLIED`、`RECONCILED_V2` 与 canonical promotion；任一步缺失或 stale 都必须整体回滚。

保存命令输出的 `planSha256`，双人复核每个 `READY`/`QUARANTINED` 决策后才可 apply：

```bash
BILLING_DATABASE_URL='<billing-db-url>' \
pnpm --filter @ruidong/api balance:reconcile-ledger -- \
  --apply \
  --plan-file '<plan-path>' \
  --plan-sha256 '<64-lowercase-hex>' \
  --confirm-database-name '<database-name>' \
  --confirm-database-identity '<database-identity>' \
  --finance-approval-ref '<finance-change-or-approval-ref>' \
  --technical-approval-ref '<technical-review-or-change-ref>' \
  --initiated-by '<operator>'
```

apply 会再次校验文件 hash、endpoint、数据库 locator、phase 和账户前置快照。账户在审批后发生变化时返回 `SKIPPED_STALE`，必须重新 dry-run，绝不能套用旧计划。

只要任一 `READY` 账户含 `legacyVoucherProofMutations`、`legacyExpiryProofMutations` 或 `invoiceStabilityProof`，以上两个 approval ref 就都必填：trim 后各为 1..200 字符且必须不同，并永久保存在对应 proof 行中。没有上述特殊证明的普通 repair 不要求这两个参数。approval ref 只是审批证据，不能替代计划 hash、数据库身份、锁内重放或数据库终态约束。

以下账户只 quarantine，不自动修改：

- 无法唯一重放交易链、allocation 或 component；
- 账本中已有无法证明的过期/退款事实；
- 历史 `GRANT_RULE`（包括看似规范的文本）；
- 发票闭包证据缺失、无效、存在非法 application，或审批后发生漂移；
- 任何数据库身份、hash 或 immutable subject 不一致。
- 企业账户出现无 receipt 的旧代金券形状；
- 无 receipt 的代金券发放前钱包不是零，或 full-remainder receipt 的 hole fill 不能由同一 run 退休的 opening debt 精确解释；
- 跨零 `SPLIT` 所在账户已有固定负序 allocation epoch，需要重排历史序号才能插入 child。

`LEGACY_DIRTY`/`QUARANTINED` 账户禁止自动过期。repair 完成后逐账户验证钱包、批次、open debt、settlement、交易尾部和 audit，再允许恢复该账户的入金。

### 8.1 UAT 47 两个伪批次账户的受审执行

2026-07-18 的 UAT 只读 dry-run 识别出两个包含旧 `MIGRATION_OPENING` 伪批次的个人账户，均为 `READY`。下表只用于锁定本次审批基线；使用当前镜像正式执行时必须重新生成 Plan V9，并以其中的 `billingAccountId`、数据库 locator、文件 SHA-256、`preconditionHash` 和 `replayHash` 识别账户，不得转换旧计划，也不得仅按表中顺序或金额匹配。

| UAT 审批基线 | 账户 1 | 账户 2 |
| --- | ---: | ---: |
| wallet | `52.907580000000` | `18.314644660000` |
| 旧伪批次金额 | `0.214852000000` | `0.187773520000` |
| transactions / grants / allocations | `215 / 3 / 213` | `864 / 3 / 863` |
| `migrationOpeningDebtMutations` | `1` | `1` |
| 退休伪批次 / 新建 paid settlement | `1 / 1` | `1 / 1` |
| `grantMutations` | `2` | `2` |
| `canonicalAllocationMutations` | **`159`** | `0` |
| 真实批次 remaining 调整 | `53.122432000000 -> 52.907580000000` | `18.502418180000 -> 18.314644660000` |

正式 apply 前必须在 writer drain 下重新 dry-run，并逐项确认：两个账户仍为 `READY` 且上述 mutation 数量和金额完全一致；账户 1 的 **159 条** `canonicalAllocationMutations` 必须逐 ID 复核 before/after，不能只核对合计；不存在新增交易、批次、allocation、settlement、退款、过期、发票引用或新的 quarantine 原因。任一数量、金额或 hash 改变都视为 snapshot stale，作废旧计划并重新审批。

每个账户 apply 后必须立即保存并核对以下证据：

- repair account 终态为 `APPLIED`，账户为 `RECONCILED_V2`；退休审计恰好保留该伪批次完整 before snapshot，而原 `MIGRATION_OPENING` grant 已不存在；
- 原 allocation 已变为同额 `NEGATIVE_BALANCE`、`balance_grant_id IS NULL`，并由后续真实入金产生同额 `PAID` settlement；真实批次只保留清偿欠款后的 remaining；
- 账户 1 计划内 159 个 canonical allocation ID 均有同一 run 的精确 before/after 审计且目标行一致，账户 2 不得出现计划外 canonical allocation 财务改写；
- 钱包、active grant、open debt、settlement、交易尾部和 component 守恒全部为零差额；不能以页面能打开替代数据库账本验收。

数据库验收通过后，再由测试人员逐一打开并导出以下 **7 张** UAT 财务 sheet，必须全部加载成功、无“财务报表明细加载失败”，且明细与本次 repair audit/账本合计一致：

1. 财务对帐—充值批次；
2. 财务对帐—余额消耗分摊；
3. 财务报表—按量纯赠—账户变动明细；
4. 财务报表—按量买赠—账户变动明细；
5. 财务报表—按量买赠—账户变动汇总；
6. 财务报表—按量买赠—当期消耗明细；
7. 财务报表—按量买赠—当期消耗汇总。

任一账户数据库验收或任一 sheet 失败，都不得把 UAT repair 宣布完成，也不得据此放宽其他账户 guard。该步骤只处理账本伪批次，不新增或改造 BALANCE 发奖能力。

### 8.2 国内生产三个匿名账户的定向门禁

2026-07-18 的生产只读核对只发现三个符合本次问题域的个人账户。下表是匿名财务等式，不是账户选择条件；正式选择仍必须使用受审 ID 清单、数据库身份和 Plan V9 hash。

| 匿名基线 | A | B | C |
| --- | ---: | ---: | ---: |
| 当前 wallet | `-0.591578080000` | `-0.043071216000` | `-0.220729600000` |
| 旧 voucher 证明 | `100`，发放前 `0`，无 receipt | `100`，发放前 `-0.081552076`，receipt remaining 错记 `100` | `200`，发放前 `0`，无 receipt |
| 错误消费拆分 | 已负余额消费全量 reclass | `0.0289413 = 0.011547084 grant + 0.017394216 debt`，另两笔全量 debt `0.0083367 + 0.0173403` | `0.2834368 = 0.0627072 grant + 0.2207296 debt` |
| opening 退休 | `2` 条，合计 `0.59157808` | `5` 条，合计 `0.081552076` | `2` 条，合计 `0.379376` |
| repair 后 open debt | `0.591578080000` | `0.043071216000` | `0.220729600000` |

B 的关键守恒必须逐项成立：旧批次 current remaining `0.03848086` 加回三笔错误 grant allocation 的 debt 部分 `0.043071216`，得到 `0.081552076`；该金额与 voucher 的 wallet hole 以及五条 opening debt 精确相等，因此 canonical replay 的 voucher 批次最终 remaining 为 `0`。不得把 pre-repair remaining 误当成 `0`，也不得把 receipt remaining 改写成净发放金额。

三账户只有在新镜像锁内重新 dry-run 后仍全部 `READY`，且交易链无断点、无重复时间歧义、无 refund/expiry/invoice/已有 settlement、无新交易、所有 immutable subject 与上述等式均未漂移时，才可进入双人审批。任一 ID、数量、金额、receipt、sequence epoch 或 hash 改变都作废旧计划并 quarantine；不得为追求当晚上线而人工改 wallet、伪造 receipt、直接改 marker，或把上述等式推广到其他账户。

### 8.3 通用发票稳定性证据 profile

`invoice-stability-evidence-v1` 只授权发票稳定性证明，不授权旧批次过期、旧代金券或企业管理员入金证明。它不硬编码环境、数据库或账户，但每次必须显式选择一个账户，禁止使用 `--account-type`、`--limit` 或 `--cursor-after` 扫描候选账户。默认 profile 仍拒绝危险发票历史。

目标环境必须已经应用完整 Prisma migration 链（包括 `20260722000100_hk_legacy_expiry_invoice_evidence_contract`），rollout control 必须精确为 `V2_CONTRACT`。先为单个账户生成新 Plan V9：

```bash
BILLING_DATABASE_URL='<billing-db-url>' \
pnpm --filter @ruidong/api balance:reconcile-ledger -- \
  --maintenance-profile invoice-stability-evidence-v1 \
  --billing-account-id '<billing-account-id>' \
  --output-jsonl '<new-plan-path>'
```

计划只有在以下条件全部成立时才可审批：恰好一个 `READY` 账户；`invoiceStabilityProof` 非空；`legacyVoucherProofMutations`、`legacyExpiryProofMutations`、`legacyAdminFundingRepairs` 全为空；订单、申请、明细和事件的 ID 集合、账户归属、用户/租户关系、金额及发票字段完整一致；`invalidApplicationCount=0`；证据 SHA-256 非零。闭包非法时 dry-run 直接 fail closed，其他 planner 风险可输出 `QUARANTINED`；如果计划出现该 profile 禁止的任何特殊 proof/mutation，即使状态为 `READY` 也不得审批，apply 会 fail closed。

保存并由财务、技术分别复核 Plan V9 文件、`planSha256`、数据库 locator、账户 ID、发票闭包计数和 `evidenceSha256`。apply 时重复输入同一个账户 ID，作为目标账户的显式二次确认：

```bash
BILLING_DATABASE_URL='<billing-db-url>' \
pnpm --filter @ruidong/api balance:reconcile-ledger -- \
  --maintenance-profile invoice-stability-evidence-v1 \
  --billing-account-id '<same-billing-account-id>' \
  --apply \
  --plan-file '<plan-path>' \
  --plan-sha256 '<64-lowercase-hex>' \
  --confirm-database-name '<database-name>' \
  --confirm-database-identity '<database-identity>' \
  --finance-approval-ref '<finance-change-or-approval-ref>' \
  --technical-approval-ref '<technical-review-or-change-ref>' \
  --initiated-by '<operator>'
```

`--initiated-by` trim 后必须为 1..200 字符；两个审批引用也必须各为 1..200 字符且不同。使用 `--resume-run-id` 时必须再次提供原 repair run 的同一个 `initiatedBy`，不允许用另一个操作人接续同一审计 run。apply 会验证 Plan V9 文件 SHA、profile、账户 ID、数据库 endpoint 和物理身份，在 Serializable 账户事务内锁定账本及完整发票闭包，重新生成计划并重算证据。审批后闭包仍合法但 snapshot/hash 变化时返回 `SKIPPED_STALE`；闭包变为非法时整事务 fail closed。两种情况都不得写 proof 或晋升账户，旧计划必须作废并重新 dry-run。

成功后必须保存 repair run/account、append-only 发票稳定性 proof、完整 `evidence_snapshot`、`evidence_sha256`、双审批引用及账户 `RECONCILED_V2` 验收结果。部署、Prisma migration、Release B、Pod 启动和 Argo 同步都不会自动生成计划或执行 apply。

### 8.4 大账户 repair 的有界执行契约

2026-08-08 生产克隆演练已经确认旧 apply 实现不适用于大账户：锁内完整 `beforeSnapshot` 序列化后为 `309,981,782` 字节，超过 PostgreSQL JSONB 单容器 `268,435,455` 字节上限；即使把容器提高到 48 GiB、RSS 峰值达到 14.96 GiB，仍在创建第一条 repair-account 时以 SQLSTATE `54000` 失败，后续 transaction/allocation audit 和更新均未开始。该失败不能通过继续增加 Pod 或节点内存解决；包含旧实现的镜像和旧计划都不得对该账户再次 apply。

repair-account 的 `beforeSnapshot` 必须改为固定版本的紧凑清单 `BALANCE_LEDGER_REPAIR_BEFORE_V1`；`RUNNING`、`SKIPPED_STALE` 和 `FAILED` 路径都不得嵌入完整 transactions、allocations、orders 或 invoice items。清单顶层必须保留 `billingAccountId`、完整 `grants` 和 `voucherIdempotencyEvidence`，并至少包含：

- `snapshotHashAlgorithm`、完整锁内快照的 `preconditionHash`；
- `accountType`、`ledgerStatus`、`ledgerVersion` 和 `walletBalanceUsd`；
- 各类原始事实的精确 `rowCounts`；
- 发票闭包的 `invoiceEvidenceSha256`（无闭包时显式为空）。

紧凑清单不是抽样或证据降级：`preconditionHash` 仍绑定完整锁内快照；每个被修改 transaction/allocation 的数据库原生 OLD/NEW 仍写入对应 append-only repair audit；发票、代金券、过期、opening debt 和管理员入金继续写各自的不可变 proof。任何必需字段、计数、hash 或完整 grant/voucher 证据无法生成时必须 fail closed，不能截断 JSON 后继续。序列化后的 `beforeSnapshot` 必须不超过 16 MiB；当前 Plan V9 终态契约中的 `afterSnapshot` 暂不改变，但应用层必须在写入数据库前验证其序列化大小不超过 192 MiB，超限即拒绝执行。

大账户 mutation 必须在同一个 Serializable 账户事务内通过 `ON COMMIT DROP` 临时 staging 表有界执行：

1. 取得账户锁、重建计划并验证 `preconditionHash`/`replayHash`；
2. 按确定性键和顺序把 transaction、allocation component 与合并后的 allocation 目标分批装入 staging；单次数据库参数 JSON 不得超过 4 MiB，不能在 Node.js 中再构造覆盖全账户的 JSON、Map 副本或一次性 Prisma 参数；
3. 先写完所有可在历史行更新前建立的特殊 proof，再写完全部 transaction audit 和 allocation audit；依赖精确序列终态的 proof 继续遵循既有数据库 guard 顺序，但不得绕过对应逐行 audit；
4. 在任何财务目标行更新前，核对 staging、audit、计划总数、唯一键、账户 subject 和 OLD 值 CAS 全部精确一致；
5. 仅在全部 audit 已落库后分批更新 transaction/allocation，最后执行守恒、终态 proof、`APPLIED` 和 `RECONCILED_V2` 晋升。

任何分批失败、漏行、重复行、CAS 漂移或终态不一致都必须回滚整个账户事务；不得按批次提交部分修复，也不得为了降低内存放宽 audit-first 顺序。事务内只允许以下局部设置：

```sql
SET LOCAL work_mem = '64MB';
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '5s';
```

禁止用 `ALTER DATABASE`、`ALTER ROLE` 或全局参数替代 `SET LOCAL`。无 VOUCHER grant 时不得扫描或锁定 `idempotency_keys`；存在 VOUCHER 时必须同时验证受支持的 direct/response receipt 形状，冲突或无法唯一归属时隔离账户。

修复后的生产候选必须在冻结镜像后，用最新生产快照创建的全新克隆完整演练；旧 Plan、旧 SHA 和旧审批全部作废。相同不可变镜像至少完成一次完整 apply 和一次独立的全新克隆/重置克隆复演，并同时满足：

- COMMIT 前的 apply 阶段必须处于 1,800 秒事务预算内，任一 SQL 不得触发 120 秒 statement timeout；COMMIT 期间 deferred constraint 校验不受这两个客户端预算约束，连接结果不确定时必须以数据库 terminal audit 判定，禁止盲目重试；
- RSS 峰值不超过容器 limit 的 70%，且以实测决定资源，不把 48 GiB 演练值写成生产规格；
- 每个参数 JSON 小于等于 4 MiB，`beforeSnapshot` 小于等于 16 MiB，`afterSnapshot` 小于等于 192 MiB；
- transaction/allocation 的 staging、audit、update 和最终目标数量逐项精确一致；
- 金额、component、序列、proof、`preconditionHash`、`replayHash` 及终态守恒全部通过，`open repair run/account = 0`。

克隆通过后，生产仍必须用该候选镜像重新 dry-run，生成新的 Plan V9 和 SHA，再由财务、技术重新审批。只有数据库返回结果不确定且 run 保持 `RUNNING` 时，才允许在终态审计可读后使用 `--resume-run-id`；resume 必须绑定原 plan SHA、profile、数据库身份、账户和同一 `initiatedBy`，先以数据库 terminal proof 判定是否已提交。已有 `FAILED`/`SKIPPED_STALE`、计划或快照变化、审批失效时不得靠 resume 重试，必须重新 dry-run、新建 run 并重新审批；不得手改 run/account 状态、删除审计或盲目重放。

## 9. 充值退款任务契约

新充值退款按订单原始 component 拆为独立任务：

```text
本金 task_key: refund:<orderId>:recharge:principal
本金 description: refund:recharge:order:<orderId>:principal
本金 refundComponent: PAID

赠额 task_key: refund:<orderId>:recharge:bonus
赠额 description: refund:recharge:order:<orderId>:bonus
赠额 refundComponent: BONUS
```

新任务 payload 只允许：

```json
{
  "description": "...",
  "billingAccountId": "...",
  "refundComponent": "PAID or BONUS"
}
```

金额必须为正数，task 的 user/tenant/product/order/account 必须与不可变订单完全一致。缺失、空字符串、非字符串、未知字段、账户不一致或 component 不一致都必须 fail closed。

历史任务 migration 只接受精确的 `{description}` 或 `{description,billingAccountId}` 两种旧 payload，且 key、description、subject、正金额和订单账户都能证明时，才为非 `SUCCEEDED` 任务补上 component。歧义的 `PENDING`/`FAILED`/`MANUAL_REVIEW` 任务统一进入 `MANUAL_REVIEW`；历史 `SUCCEEDED` 永远只读，不回写。

## 10. 批次过期恢复门禁

恢复过期 worker 前必须同时满足：

- Release B phase 为 `V2_CONTRACT`，strict trigger count 为 15；
- due legacy 查询为 0；
- 计划处理的账户全部为完整 `RECONCILED_V2`；
- 不存在 malformed grant、缺钱包、component 不守恒或跨账户 allocation；
- 账户级多批次过期集成测试已通过。

worker 每次先按到期批次分页发现账户，再在账户事务中锁定并读取该账户全部批次。`limit` 只限制本轮发现页的候选批次数；一旦某个账户被发现，就不允许把该账户的到期批次拆成多次提交。只要账户仍为 `LEGACY_DIRTY`，或任一批次事实异常，整账户必须回滚并告警，不能只跳过坏批次后继续扣其他批次。

## 11. 验证清单

上线前至少完成：

```bash
pnpm --filter @ruidong/api typecheck
pnpm --filter @ruidong/api test -- --runInBand \
  --testPathPattern='billing.service.spec|balance-ledger-repair.spec|credit-grant-executor.spec|refund-compensation.service.spec|billing.admin.service.spec|balance-grant-expiry.service.spec|billing-workspace-mirror.service.spec|enterprise-account.service.spec|reconcile-personal-balance-ledger-script.spec'

BILLING_DATABASE_URL='<isolated-db-url>' \
TEST_DATABASE_NAME='<isolated-test-db-name>' \
pnpm --filter @ruidong/api test:balance-ledger:integration
```

数据库集成库必须从空库应用完整 Release A，再单独执行 Release B；验证 `phase=V2_CONTRACT` 和 strict trigger count `15`。测试至少覆盖：

- 第 3 节完整截图序列及两个 public read API；
- 并发扣费、并发充值与欠款 FIFO；
- 同账户多个到期批次一次提交，任一异常时整账户不变；
- 企业账户即使传入 `allowNegativeBalance` 也不能绕过额度；
- 财务锁等待期间批次跨过期边界时使用锁内 `financialNow`；
- 退款 `PAID`/`BONUS`、幂等重放、非法金额、非法账户和非法 payload；
- 直接只改 grant、批次间等额挪余额、只改 wallet、移动 wallet 主键、改变 CLEAN account type、漏 refund allocation 或伪造 transaction 时数据库以 SQLSTATE `23514` 拒绝并完整回滚；显式伪造 allocation sequence 必须被数据库覆盖为新的正序；
- 旧缓存投影不能覆盖后提交事务，账户重新绑定后不能写入错误 tenant key；
- BALANCE 发奖在任何财务写入前 fail closed，历史 `GRANT_RULE` 保持 quarantine。
- 精确 `MIGRATION_OPENING` 形状能在完整事务中退休并晋升 canonical；缺少 settlement、退休证据或 terminal promotion 时，allocation 改写、伪批次删除和全部审计必须由 deferred guard 整体回滚。
- `LEGACY_DEBT_SPLIT_V1` 与 `LEGACY_DEBT_RECLASS_V1` 必须覆盖精确小数、完整 OLD/NEW CAS、确定性 child、重复执行和 stale snapshot；缺 proof、缺 audit、已有负序插槽冲突或任一 terminal mismatch 时不得留下部分 allocation/settlement/marker。
- 代金券 PRE/no-receipt 与 full-remainder absorption 必须分别覆盖零余额发放和 `0.081552076` hole 闭环；缺少任一审批引用、重复/矛盾 receipt、非 opening debt、企业账户或 proof mutation 时必须 fail closed，且不得生成任何伪 receipt。
- 大账户规模测试必须覆盖至少 243,079 条 transaction 和 243,076 条 allocation，证明 staging 输入有界、audit 全部先于财务更新、逐批数量/CAS 精确；在 staging、两类 audit、两类 update 和终态写入前分别注入失败，数据库均不得留下部分 repair。
- 记录每个 apply 阶段的耗时、RSS/heap/external/cgroup peak、分批行数和参数字节数；测试必须证明第 8.4 节所有 JSON、内存、SQL 和总耗时门禁均通过，且无 VOUCHER 账户没有执行 `idempotency_keys` 全表扫描。

另外执行 `git diff --check`，并确认没有把 Release B 放入 Prisma migrations，也没有引入本次范围外的发奖、推荐、CREDIT 或发票设计。

## 12. 恢复、监控与回退

按以下顺序小流量恢复：

1. 先恢复已验证账户的充值/赠额/代金券/人工调额；
2. 再恢复同步充值退款和 refund-compensation worker；
3. 最后在第 10 节门禁全绿后恢复过期 worker；
4. BALANCE 发奖继续关闭，等待独立设计。

`LEGACY_DIRTY` 账户不得自动过期；其 remaining 为正的批次到期后，普通消费（包括继续进入个人负余额）和充值/赠额/代金券/人工调额等入金 fail closed 是预期行为。在该账户完成受审 repair 并成为完整 `RECONCILED_V2` 前，不承诺这些入口可用，也不得为恢复可用性绕过 guard。

每轮监控必须执行以下查询：

```sql
SELECT a.id AS billing_account_id,
       MIN(g.expires_at) AS first_due_at,
       COUNT(*) AS due_grant_count
FROM billing_accounts a
JOIN balance_grants g ON g.billing_account_id = a.id
WHERE a.balance_grant_ledger_status = 'LEGACY_DIRTY'
  AND g.is_expired = FALSE
  AND g.remaining_amount_usd > 0
  AND g.expires_at IS NOT NULL
  AND g.expires_at <= clock_timestamp()::timestamp(3)
GROUP BY a.id
ORDER BY first_due_at ASC, a.id ASC;
```

该查询结果零容忍，正常值必须为 `0` 行。首次出现任意一行，或首次出现该类账户的消费/入金 guard failure，告警阈值即为 `1`：立即告警、把清单内账户置于最高 repair 优先级，并确认账本 guard 已让这些账户的消费和入金事务完整回滚，不得等待连续失败、错误率窗口或用户投诉。受影响账户保持 fail closed，直到完成新的 dry-run、审批、apply 和逐账户账本验收；不得因此关闭其他已验收个人账户的负余额入口。只有 guard 未能阻止事务提交或出现任何账本差额时，才立即停止对应入口的全量 writer。

重点监控：钱包与批次差额、open debt、repair quarantine、过期整账户回滚、refund `MANUAL_REVIEW`、SQLSTATE `23514`、事务 lock timeout、缓存投影失败。上述到期查询出现首行或对应 guard failure 出现首个事件时，立即隔离受影响账户并保存完整证据；任何差额非零或 guard 绕过则立即停止对应入口的全量 writer。

本次采用 fail-forward：

- Release A 后、Release B 前可以保持 `EXPANDED/CUTOVER_READY` 并继续 writer drain，修复问题后重新 prepare；不得手改 phase。
- Release B 已进入 `V2_CONTRACT` 后，不得部署旧 writer、删除 strict trigger、清空 audit、回退 schema 或伪造批次来恢复流量。
- 应用问题通过兼容 V2 contract 的新版本前滚；数据问题进入 quarantine，依据新的 dry-run/hash/数据库身份执行受审 repair。
- 若事务提交结果因连接中断未知，以数据库 terminal audit 为准；不得盲目重放财务操作。

上线证据包必须保留 migration 输出、SQL 查询结果、测试日志、代码审核结果、审批人和变更工单。所有检查完成前不提交远端、不合并、不恢复全量流量。

大账户 repair 还必须额外保留：失败演练原始日志、旧/新 JSON 字节数、阶段内存与耗时、staging/audit/update 精确计数、两次全新克隆演练结果、新 Plan V9/SHA 及重新审批记录。连接中断、P2028 或进程退出后的恢复必须先读取 repair run/account 和 terminal proof；只有第 8.4 节定义的未知提交状态允许 resume，其他失败不得把“重启 Job”当成恢复动作。
