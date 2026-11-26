# 北京 test/nprod 存量 BillingAccount 币种标签修复手册（2026-08-13）

## 1. 目标和不可变边界

本次只修复北京 test/nprod 固定 manifest 中 71 个存量
`BillingAccount.currency`：`USD -> CNY`。其中 68 个为 active 账户；3 个为已删除账户，
各自只保留一条固定的历史 owner membership 元数据，不存在可达 tenant、API key、订单、用量或资金事实。

这是部署币种标签更正，不是外汇换算。钱包、授信、债务、订单、发票、余额批次、账本交易、用量和 Gateway 事实都不得改变。特别地：

- `ba_personal_1585cfd1-aea9-42b1-bb54-5a89286d921b` 的历史余额为
  `-0.024176940000`，该值与账本交易和用量闭合；修复后必须原值保留。
- `40703476-f6de-4528-8119-11d494bfe2f4` 的 active 授信额度为
  `100` 个平台主币种单位；修复后必须原值保留。
- 6 个固定 `PENDING/CNY/ALIPAY` 订单只因精确证明未支付、未履约且无资金事实才允许保留；本次不改变订单状态。
- 只有 2 个精确 event/request/evidence 绑定的历史币种隔离事件，才可在标签修复后进入
  `gateway-unanchored-absorb-v1` 零金额终态。

`20260813000102_beijing_nprod_currency_label_repair_v2` 是 install-only migration。
`prisma migrate deploy` 只安装固定 manifest、受控函数和 verifier，绝不自动修改账户。严禁直接
`UPDATE billing_accounts`，严禁修改 manifest，严禁临时关闭币种不可变触发器。

## 2. 发布顺序

顺序不可颠倒：

1. 固定旧镜像，暂停自动扩缩容与自动回滚；停止 Gateway 用量入口。
2. 停止 Kafka usage consumer、Billing 普通 writer、支付/退款/履约 worker、Publisher sync worker、restriction projection worker 和相关 Admin 写入口。
3. 记录 Kafka consumer group offset/lag、Publisher backlog、restriction intent backlog、Pod/replica、DB 活跃写事务和数据库快照；确认 writer 已排空。
4. 使用独立 migration Job 按顺序安装 `00100`、`00101`、`00102`、`00103`；不要启动新 Billing。
   `00103` 是共享的 v1 apply 名称解析 hotfix，只精确修复 00100 函数内三处歧义引用，
   不修改 00100 历史 checksum，也不会执行任何标签数据迁移。
5. 执行 `00100/verify.sql`、`00102/verify.sql` 和 `00103/verify.sql`，确认数据库身份、
   71 户 manifest、6 个订单、2 个事件、函数/触发器/ACL 全部匹配且 audit 为空。
6. 用 migration owner 采集 `billing_account_currency_label_evidence_v2()`；maker 与两名不同 checker 在同一变更单批准数据库 locator、manifest hash 和 evidence SHA。
7. 在持续停写状态调用唯一的 `apply_legacy_billing_account_currency_label_repair_v2`；完成 post-apply 断言。
8. 部署新 Billing，但保持普通 ingress、Kafka consumer 和普通 worker 关闭；只启动受控 Admin API、Publisher 依赖和 restriction projection worker。
9. 两个事件逐条执行零金额 absorb；每条都等待 restriction intent、Publisher delivery 和 Gateway 准入全部成功后，才处理下一条。
10. 两条均闭环后，先启动单副本 consumer，观察 offset、隔离事件和错误日志；再恢复普通 writer、Gateway 入口和正常副本数。

restriction projection worker 在第 2 步停止，在第 8 步明确恢复。不能在 worker 停止时等待 intent
`SUCCEEDED`，也不能在 intent 成功前恢复普通流量。

## 3. 安装期验证和数据库身份

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

目标 locator：

```text
database_name              ruidong_billing_v2
database_identity          3f8df065-d032-4728-939a-db8fd4735533
database_system_identifier 7610171897653500696
database_oid               40312
deployment                 domestic / CNY
phase                      V2_CONTRACT
```

任一字段不符即停止。数据库名称相同不代表数据库身份相同。

## 4. 固定 manifest

- 账户数：71；manifest SHA-256：
  `273fe03908a9d463556a6e9e5c60faba681c480d62064447f4f1b765051340e5`
- active：68；deleted inert with fixed member metadata：3；成员证明 SHA-256：
  `856224622e1dd48ecff2b64fb6f502d9bd707eca237316b1cca503f7e8cfe59e`。
- 8 条固定历史 ledger-repair 异常审计行必须保持原样，并由当前账本或固定后继
  `COMPLETED/APPLIED` 权威行闭合；异常证明 SHA-256：
  `18312e4653fb9a6755f2bf99280cd4037ab3a1a25828a22d8ee2e08e43a9ef4f`。
- 关联发票闭包固定为 20 个 application、25 个 item、54 个 event，全部申请币种为 CNY；
  完整快照 SHA-256：
  `36ac0df9c711fb81145f586014671f57880967c96f0b13c197f56d21d2a64f54`。
- PENDING 空壳订单：
  - `09ee75b0-e62a-40b8-8c9b-550cf15b8063`
  - `2c9540bc-b94b-4975-a07b-4edb182bdc4a`
  - `6890010b-0417-4638-912a-f5f602645d7f`
  - `7d9f1bce-4acd-4204-804c-b8b92b879a71`
  - `9950aa2f-4f82-41b0-94c5-de1e1480efd2`
  - `a67ac72f-5d93-4084-99de-ecf5ecca829c`
- eligible request：
  - `bee9e76a-9181-4a3d-a31a-78360dcf4263`
  - `486afec5-249d-4b33-958d-40f69b89d1ee`
- 两个 eligible event 各自必须仍有且仅有一条
  `ACTIVE/settlement_policy_review` restriction，并各有且仅有一条已经
  `SUCCEEDED` 的 `ACTIVE` projection intent；restriction proof SHA-256：
  `39a875f0368f92e39d4e308620885b8423f4f074ad7c79a109c271e0fc028ef3`。

运行中的 test 数据可能变化。审批必须使用停写后由数据库函数重新计算的 evidence SHA；在线审计时的
SHA 只能用于代码 manifest 复核，不能代替 apply 参数。

## 5. 采证和 apply

由 migration owner 执行：

```sql
SELECT manifest_hash, evidence_sha256, evidence_snapshot
FROM billing_account_currency_label_evidence_v2();
```

保存完整 JSONB、evidence SHA、数据库 locator、writer drain 证据和审批人。随后在同一停写窗口执行：

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;
SHOW transaction_isolation; -- 必须返回 read committed

SELECT *
FROM apply_legacy_billing_account_currency_label_repair_v2(
  'ruidong_billing_v2',
  '3f8df065-d032-4728-939a-db8fd4735533'::uuid,
  '273fe03908a9d463556a6e9e5c60faba681c480d62064447f4f1b765051340e5',
  '<CHANGE_TICKET>',
  '<OPERATOR>',
  '<APPROVER_ONE>',
  '<APPROVER_TWO>',
  '<EVIDENCE_SHA256>',
  'LABEL_ONLY_NO_FX',
  '<WRITERS_DRAINED_UNTIL>'::timestamp(3)
);

COMMIT;
```

预期只返回一行：`manifest_version=beijing-nprod-legacy-usd-label-v2`、
`status=APPLIED`、`account_count=71`。相同参数只允许幂等读取；任何参数、数据或终态证明变化都必须失败。

## 6. Post-apply 门槛

恢复任何应用组件前必须同时满足：

- run `APPLIED/71`，items `71`，eligible events `2`；
- 71/71 账户为 CNY，全库遗留 USD 账户为 0；
- reachable account currency mismatch 为 0；
- `billing_accounts.currency` 默认值为 `NULL`；
- 每个 item 的 before/after 只差 `currency`，financial snapshot hash 不变；
- 6 个订单仍为 `PENDING/CNY/ALIPAY/NOT_STARTED` 且无支付、履约、退款和账务事实；
- 历史负余额、企业授信、钱包、账本、grant、allocation、订单、发票、usage 数量和金额均不变；
- 20/25/54 发票 application/item/event 完整快照与 apply 前字节一致；
- 两个 eligible event 各自仍恰好对应一条 `ACTIVE/settlement_policy_review`
  restriction，以及一条 `restriction_status=ACTIVE/status=SUCCEEDED` 的 projection intent；
- transaction-local repair marker 为空；`billing_accounts_currency_immutable` trigger 为 enabled。

## 7. 两事件闭环

使用国内 Admin BFF：

```text
POST /api/admin/gateway-billing-events/bee9e76a-9181-4a3d-a31a-78360dcf4263/absorb
POST /api/admin/gateway-billing-events/486afec5-249d-4b33-958d-40f69b89d1ee/absorb
```

请求必须携带当前 revision、唯一 idempotency key、`gateway-unanchored-absorb-v1`、本次
repair run ID、该事件所属账户的 repair item ID，以及固定 manifest hash。

每条预期：事件 `ABSORBED/CLOSED`；恰好一条 ABSORB action 和一条零金额 terminal receipt；
对应 restriction `RELEASED`；对应 projection intent 为
`restriction_status=RELEASED/status=SUCCEEDED`；Publisher delivery 成功；Gateway 下一次请求不再返回
`manual_freeze/billing_review`。不得生成 TokenUsage、credit transaction、anchor、reservation、platform loss 或用户扣款。

## 8. 失败和回滚

- apply 报错：事务整体回滚，保持停写，重新采证和审批；禁止直接 DML。
- 任一严格 migration 已提交后，默认只允许前滚；不得承诺旧 Billing 可在新触发器下恢复消费。
- 标签 apply 已提交后不得改回 USD；没有做 FX，反向改标签会重新制造错误。
- absorb 已提交但投影失败：用同一幂等键修复投影，不得生成第二条 receipt。
- 只有 migration、标签、两事件、Publisher/Gateway、Kafka consumer 健康全部核验通过，才能恢复普通流量。
