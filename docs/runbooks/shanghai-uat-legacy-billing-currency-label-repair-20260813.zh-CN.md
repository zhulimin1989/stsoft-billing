# 上海 UAT 存量 BillingAccount 币种标签修复手册（2026-08-13）

## 1. 结论与边界

本次只把固定白名单内 10 个存量 `BillingAccount.currency` 从 `USD` 更正为 `CNY`。它是标签修复，不是外汇换算：钱包、余额批次、交易、订单、授信、Gateway 用量及所有金额字段必须逐字节保持不变。

`20260813000100_legacy_billing_account_currency_label_repair` 是 install-only Prisma migration。自动 `prisma migrate deploy` 只安装受控函数、不可变触发器扩展和 append-only 审计表，绝不会自动执行 repair，也不会按命中 ID 自动修改任何环境的数据。后续 `20260813000103_legacy_currency_label_v1_apply_name_resolution_hotfix` 是共享的 v1 可执行性修复：它只在精确旧定义上为三处歧义列引用增加表别名，不修改 `00100` 历史 checksum，不执行任何数据迁移。非上海 UAT 环境不存在完整目标 cohort 时是可核验的 no-op；严禁在那里调用 apply 函数。

本变更不要求迁移全库数据，也不处理任意 USD 账户。唯一批准范围是：

- 固定 10 个账户，manifest SHA-256 为 `1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6`；
- 3 个未付款、无交易号、无到账、无退款、无履约和无账务事实的 `PENDING/CNY/ALIPAY` 订单；
- 6 个终态 `FAILED/USD/STRIPE` 尝试，且无 provider、到账、退款、履约和账务事实；
- 3 个精确绑定 event/request/evidence 的历史无锚币种不匹配事件。账户级 repair 证明不能授权同一账户上的其他事件。

任一行、哈希、金额、状态、数据库身份、审批或 writer drain 与 manifest 不一致，受控函数都会整事务失败。禁止直接 `UPDATE billing_accounts`，禁止修改 manifest SQL，禁止用临时关闭触发器绕过门禁。

## 2. 发布顺序

顺序不可颠倒：

1. 先进入维护窗口，停止流量生产入口、consumer 和全部相关 writer，并完成排空证据；旧 binary 保持停止。
2. 在停写状态按顺序部署 `00100`、`00101`、`00102`、`00103` 四条 install-only Prisma migration；确认只安装对象，不启动任何 binary。`00102` 是北京 nprod 的固定 v2 manifest，在上海 UAT 必须是 no-op；`00103` 只修复 v1 apply 的三处 PostgreSQL 名称解析歧义。
3. 依次运行 `00100/verify.sql`、`00102/verify.sql`、`00103/verify.sql`，证明上海 cohort 完整、北京 manifest 在本库 no-op、v1 函数已精确修复且仍仅 owner 可执行，同时审计表为空、标签尚未变化、触发器/ACL/manifest 完整。
4. 采集数据库绑定证据并由 maker + 两名独立 checker 审批。
5. 只通过受控 apply 函数执行一次 10 账户标签修复；做 post-apply 断言。
6. 在标签已经修复后，部署带 currency preflight 与精确无锚终态证明的新 binary，但保持流量入口关闭、consumer disabled/replicas=0；只启动执行 Admin repair 所需的受控 API、restriction projection worker 和 Publisher 依赖。此时 production currency preflight 必须通过。反过来先启动 consumer 会 fail closed。
7. 先核对并保存 restriction/Publisher 既有 backlog，再逐条处理固定 3 个 eligible Gateway 事件；每条必须同步确认直接 Publisher 投影和对应 restriction projection intent 都成功，才能处理下一条。
8. 全部终态、Publisher 与 Gateway 核验通过后，才启用 consumer 并恢复普通流量和 writer。

若发布系统无法把 migration 与 binary 拆成两个阶段，仍必须先进入维护并停掉 ingress/writer/consumer，再部署新版本，同时用发布配置把 consumer 和所有 worker 保持 disabled 或 replicas=0。label apply 与新 binary readiness 都完成后，只定向恢复 restriction projection worker 和 Publisher 依赖；不得让随镜像启动的旧/新 consumer 抢在 label apply 前消费消息。

若任何步骤失败，保持停写，不继续下一阶段。

## 3. 维护窗口与 writer drain

暂停并确认以下写入口实例数为 0：

- Billing API 中创建/变更账户、tenant/API key 绑定、余额、授信、订单、退款、履约的入口；
- Gateway 用量 Kafka consumer、重试 worker、对账/吸收入口；
- 余额批次过期、充值、赠额、退款补偿、payment webhook worker；
- restriction projection worker、Publisher sync worker/scheduler；
- Admin 侧账户、Provider、Key、订单和 Gateway reconciliation 写操作。

维护负责人需保存：停止前后 pod/replica 清单、Kafka lag/active consumer group、未终态 Publisher/restriction intent、活跃 DB 写会话，以及 drain 起止时间。必须先停止产生目标用量事件的入口，再把 consumer member 降为 0；此后 Kafka lag 应稳定并记录为待恢复基线。若仍有上游不可阻断流量导致 lag 增长，必须证明这些消息尚未被旧 binary 消费并扩展维护窗口，不能把“lag 增长”误报成排空。数据库不得存在上述表的未提交写事务。

三个 `PENDING` 订单不阻断 repair 的原因仅是受控函数逐 ID 证明它们尚未付款且没有任何财务/履约事实。订单仍保持 `PENDING`，本次不结单、不退款、不改金额：

```text
9d2903d9-7475-4f02-af74-3f61c8cc3c55
88805844-5b2e-4659-a2da-a5fd9623cd57
e26322b8-b865-43f9-a654-8b215c23c695
```

## 4. 安装期只读验证

在 migration 使用的同一数据库 URL 上执行：

```bash
set -euo pipefail
: "${BILLING_DATABASE_URL:?BILLING_DATABASE_URL is required}"
cd /app/apps/api
pnpm exec prisma db execute \
  --file prisma/migrations/20260813000100_legacy_billing_account_currency_label_repair/verify.sql \
  --url "$BILLING_DATABASE_URL"
pnpm exec prisma db execute \
  --file prisma/migrations/20260813000102_beijing_nprod_currency_label_repair_v2/verify.sql \
  --url "$BILLING_DATABASE_URL"
pnpm exec prisma db execute \
  --file prisma/migrations/20260813000103_legacy_currency_label_v1_apply_name_resolution_hotfix/verify.sql \
  --url "$BILLING_DATABASE_URL"
```

上海 UAT 的 `00100` verifier 必须输出 cohort 完整且尚未 apply 的 NOTICE，`00102` verifier 必须输出 non-target no-op，`00103` verifier 必须通过精确 repaired-definition hash 与 owner-only ACL 校验。出现部分目标账户、已有 audit 行或任意 DDL/ACL/哈希不符即停止。

同时记录数据库定位信息并与审批单逐字段比对：

```sql
SELECT current_database() AS database_name,
       (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid,
       system_identifier
FROM pg_control_system();

SELECT database_name, database_identity,
       database_system_identifier, database_oid, phase
FROM balance_ledger_rollout_control
WHERE id = 1;
```

目标值为数据库 `ruidong_billing`、`database_identity=391bbe78-97b4-46fa-b379-6970a05ea1b6`、`system_identifier=7658119346838937636`、`database_oid=16400`、phase `V2_CONTRACT`。任一不符不得继续；数据库名相同不代表身份相同。

## 5. 采集不可变证据与审批

用 migration owner 执行证据函数；函数没有授予 runtime/PUBLIC 执行权：

```sql
SELECT manifest_hash, evidence_sha256, evidence_snapshot
FROM billing_account_currency_label_evidence_v1();
```

保存完整 JSONB 结果到审批附件，记录返回的 `evidence_sha256`。它绑定当前数据库身份、domestic/CNY deployment config、10 个账户快照及全部相关财务事实。完成 maker/checker 审批：operator、approver one、approver two 必须是三个不同主体，change ticket、证据 SHA 和数据库身份必须写入同一审批单。

证据采集之后继续保持停写。任何新订单、用量、退款、余额、restriction、Publisher 或身份事实都会使 apply 在 SHARE lock 下重新计算证据时失败。

## 6. 唯一允许的 apply 入口

先生成至少比当前数据库时间晚 15 分钟的 drain horizon，再在 migration owner 的单一会话执行。所有参数都必须来自已审批证据，不能临时替换：

```sql
SELECT *
FROM apply_legacy_billing_account_currency_label_repair_v1(
  'ruidong_billing',
  '391bbe78-97b4-46fa-b379-6970a05ea1b6'::uuid,
  '1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6',
  '<CHANGE_TICKET>',
  '<OPERATOR>',
  '<APPROVER_ONE>',
  '<APPROVER_TWO>',
  '<EVIDENCE_SHA256>',
  'LABEL_ONLY_NO_FX',
  '<WRITERS_DRAINED_UNTIL>'::timestamp(3)
);
```

预期只返回一行：`manifest_version=shanghai-uat-legacy-usd-label-v1`、`status=APPLIED`、`account_count=10`。

apply 在一个事务中完成：验证固定 manifest、锁住所有身份/订单/账务/用量事实表、重新计算证据、写入 run/item、设置 transaction-local 标签转换标记、逐账户 compare-and-swap、证明除 `currency` 外没有变化、写入 3 条 eligible-event 审计、清除标记并验证终态。触发器从未被删除；标记不存在时仍严格拒绝任何币种变更。

相同的全部审批参数可以做幂等读取；任何参数变化或终态证据漂移都会失败，不能借重试扩大权限。

## 7. Post-apply 强制断言

apply 返回后立即在只读会话执行：

```sql
WITH target AS (
  SELECT billing_account_id
  FROM billing_account_currency_label_manifest_v1()
), terminal AS (
  SELECT r.id AS run_id, r.manifest_hash, r.status, r.account_count,
         count(DISTINCT i.id) AS item_count,
         count(DISTINCT e.id) AS event_count
  FROM billing_account_currency_label_repair_runs r
  JOIN billing_account_currency_label_repair_items i ON i.run_id = r.id
  LEFT JOIN billing_account_currency_label_repair_eligible_events e
    ON e.run_id = r.id
  WHERE r.manifest_version = 'shanghai-uat-legacy-usd-label-v1'
  GROUP BY r.id
)
SELECT * FROM terminal;

SELECT count(*) AS target_count,
       count(*) FILTER (WHERE a.currency = 'CNY') AS cny_count,
       count(*) FILTER (WHERE a.currency <> 'CNY') AS invalid_count
FROM target t JOIN billing_accounts a ON a.id = t.billing_account_id;

SELECT count(*) AS invalid_item_hashes
FROM billing_account_currency_label_repair_items i
WHERE encode(sha256(convert_to(i.before_account_snapshot::text, 'UTF8')), 'hex')
        <> i.before_account_snapshot_hash
   OR encode(sha256(convert_to(i.after_account_snapshot::text, 'UTF8')), 'hex')
        <> i.after_account_snapshot_hash
   OR encode(sha256(convert_to(i.financial_snapshot::text, 'UTF8')), 'hex')
        <> i.financial_snapshot_hash
   OR i.after_account_snapshot
        <> jsonb_set(i.before_account_snapshot, '{currency}', '"CNY"'::jsonb);

SELECT count(*) AS invalid_event_proofs
FROM billing_account_currency_label_repair_eligible_events e
JOIN billing_account_currency_label_repair_items i ON i.id = e.item_id
WHERE e.failure_code <> 'BILLING_CURRENCY_MIGRATION_REQUIRED'
   OR e.failure_reason <> 'settlement_anchor_missing'
   OR e.error_fingerprint <>
      'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137'
   OR encode(sha256(convert_to(jsonb_build_object(
        'runId', e.run_id,
        'billingAccountId', i.billing_account_id,
        'gatewayBillingEventId', e.gateway_billing_event_id,
        'requestId', e.request_id,
        'evidenceId', e.evidence_id,
        'evidenceHash', e.evidence_hash,
        'failureCode', e.failure_code,
        'failureReason', e.failure_reason,
        'errorMessage', e.error_message,
        'errorFingerprint', e.error_fingerprint,
        'eventSnapshot', e.event_snapshot
      )::text, 'UTF8')), 'hex') <> e.row_hash;

SELECT current_setting('billing.currency_label_repair_run_id', true)
       AS transaction_marker;

SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'billing_accounts'::regclass
  AND tgname = 'billing_accounts_currency_immutable'
  AND NOT tgisinternal;
```

预期：run 一条 `APPLIED/10`、item `10`、eligible event `3`；账户 `10/10 CNY`；两个 invalid count 都是 `0`；transaction marker 为空；immutability trigger 为 `O`。再按审批附件比较每个 item 的 `financial_snapshot_hash` 与 apply 前 evidence，证明数值没有换算。

## 8. 部署新 binary 与精确三事件处理

只有第 7 节全部通过，才部署带 currency preflight 和 `gateway-unanchored-absorb-v1` 的新 binary。保持 Kafka consumer disabled/replicas=0、普通 ingress 和 writer 停止，只恢复受控 Admin API、健康探针、restriction projection worker 及其 Publisher 依赖；其他 worker 仍保持关闭。新 binary 的 production currency preflight 必须通过。

在执行第一条命令前，记录既有 restriction projection intent 与 Publisher backlog，确认 worker 能消费但没有新的普通业务写入。然后逐条调用 Admin：

```http
POST /api/admin/gateway-billing-events/5d293fa0-5535-461e-84ca-f6cdbc5b6f79/absorb
POST /api/admin/gateway-billing-events/fa5f8903-eba4-4f49-902c-778b7990170e/absorb
POST /api/admin/gateway-billing-events/fe1c94d3-61b2-46c5-97a9-a690a2771bca/absorb
```

以上国内 Admin BFF 是操作主入口，使用登录管理员身份与
`admin.page.gateway_billing_events.absorb` 权限，并由 BFF 完整记录操作者及 repair proof。
`/api/internal/billing/admin/...` 仅是服务间接口，不作为人工运维调用路径。

每个请求 body 使用相应 event 的当前 `expectedRevision`，相同 `currencyRepairRunId`，但必须使用该事件所属的精确 `currencyRepairItemId`；`manifestHash` 固定为上文 SHA。示例：

```json
{
  "expectedRevision": 1,
  "reason": "approved legacy UAT currency-label remediation; zero-value platform absorb",
  "idempotencyKey": "uat-currency-label-absorb-<REQUEST_ID>-r1",
  "protocol": "gateway-unanchored-absorb-v1",
  "currencyRepairRunId": "<APPLIED_RUN_ID>",
  "currencyRepairItemId": "<ACCOUNT_ITEM_ID>",
  "manifestHash": "1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6"
}
```

每次调用后等待该事件生成的 restriction projection intent 到达 `SUCCEEDED`，并核验直接 Publisher 投影/Gateway 准入状态，再处理下一条。预期事件变为 `ABSORBED/CLOSED`，恰好一条 `ABSORB` action 和一条 `amount_usd=0`、`policy_version=gateway-unanchored-absorb-v1` receipt；不得生成 TokenUsage、credit transaction、settlement anchor、funding reservation、platform loss 或任何扣款。

该入口会要求 Publisher 基于当前账户事实重新生成 key balance 投影；Publisher 失败会使 API 报错，不能被一句“吸收成功”掩盖。逐条保存：API response/request ID、action/receipt/fingerprint、restriction 的 `RELEASED` 行、对应 restriction projection intent 的 `SUCCEEDED`、Publisher sync job 的终态响应，以及 Gateway 侧 key 不再 `manual_freeze` 的探测结果。不得直接修改旧 Publisher task body，也不得手工解冻 Gateway 规避投影失败。

三条事件全部核验后，再确认 10 个账户所有有效 key 的 Publisher/Gateway 投影与 Billing 当前余额一致，Publisher backlog、restriction intent backlog、Kafka error/retry 均为 0，最后恢复 consumer 和普通 writer。

## 9. 失败与回滚原则

- apply 函数报错：事务会回滚，标签和 audit 都不改变。保持停写，修复证据/环境问题后重新走审批；不得直接 DML。
- apply 已提交：不允许把标签改回 USD。历史金额没有做 FX 换算，反向改标签会重新制造错误且 append-only 证明也不允许覆盖。只能保持停写并以前滚修复恢复服务。
- 新 binary 或三事件处理失败：已提交的 CNY 标签保持不变；保持 consumer/相关 writer 停止，保留失败 action/receipt/Publisher 证据，修复新 binary 后前滚。不要回滚到会把 CNY 当 USD 或缺少 preflight 的旧 writer。
- 单个 absorb 已提交但投影失败：协议 action/receipt 是永久终态；使用同一幂等键重放只允许修复 restriction/Publisher 投影，不得生成第二笔 receipt。
- 非目标环境：仅保留 install-only 数据库对象和 `_prisma_migrations` 审计；不要创建 repair run/item，也不要调用 apply。

恢复流量的唯一准入是：10 个标签和所有 financial hash 正确、3 个精确事件均为零值终态、Publisher/Gateway 投影全部成功、无活跃 `manual_freeze`、无待处理 restriction intent/Publisher sync、consumer 健康且无错误日志。
