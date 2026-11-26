# 企业信用额度（Enterprise Credit）设计说明

最后更新：2026-08-06

## 1. 术语表——三个 "credit" 是三个东西

代码库里有三个互不相关的 "credit" 概念，维护时不要混淆：

| 术语 | 位置 | 含义 |
|------|------|------|
| **Enterprise Credit（企业信用额度）** | `billing_account_credit_configs` / `EnterpriseAccountService` / 本文档 | 企业账户的**授信**：钱包余额可以透支到 -limit，先消费后付款 |
| **Credits（积分）** | `credit_transactions` / `credit-grants` 模块 / `CreditReconcileWorkerService` | 订阅套餐的**用量积分**（CREDITS 计量单位），与资金无关 |
| **CreditPolicy（个人透支策略）** | `CreditPolicyService` | 个人账户按产品维度的小额透支策略（P2-C），与企业授信互斥：企业账户扣费路径不走 CreditPolicy |

注意 `credit-reconcile-worker` 对账的是第二种（积分），`enterprise-credit-overdue-worker` 处理的是第一种（授信账期）。

## 2. 货币语义约定（重要）

**所有 `×_usd` 命名的金额列（`limit_usd`、`balance_usd`、`amount_usd` 等）实际存储的是"平台货币"金额，不一定是美元。**

- 平台货币按部署解析（`platform-currency.ts`）：国内部署 = CNY，国际部署 = USD，可用 `BILLING_PLATFORM_CURRENCY` 覆盖。
- 单部署单币种是硬性假设：同一套库里所有金额同币种，不做汇率换算。
- `WorkspaceBalanceReport.currency` / 企业账户 `currency` 字段透出实际币种，前端展示一律以此为准。
- 列名带 `usd` 是历史遗留；改名成本高（几十张表），用本约定文档钉死语义。**新增金额列请命名为 `×_amount` 并配 currency 上下文，不要再扩散 `_usd` 后缀。**

## 3. 账号主体分离（个人账号与企业账号并存）

企业认证通过（provisioning ACTIVE）后，会给同一个登录用户开通一个新的企业账号主体：

1. **不吸收个人账号**：企业开通不迁移 owner 的个人工作区、个人钱包余额、欠款或未耗尽
   balance grants；历史个人账单、发票与 TokenPlan 锚点继续留在个人 tenant。
2. **企业账号显式绑定企业 tenant**：企业认证链路创建 `type=enterprise` 的 tenant，
   再通过 `attachEnterpriseTenant` 挂到企业 `billingAccountId`。企业信用额度只作用于这个
   企业账务主体；企业 tenant 未绑定账务账户时默认 fail-closed，不回落到个人账户。
3. **普通工作区默认归个人账务**：workspace mirror 对无绑定的新 `personal/team` tenant，
   一律绑定 owner 的个人账务账户；不会因为 owner 名下存在企业账户而自动挂企业账务。

工作区的 `type`（personal/team/enterprise）只描述协作形态，不代表账务主体；
账务主体一律看 `tenant.billingAccountId`。用户侧通过当前 tenant 在个人账号与企业账号之间切换。

## 4. 授信模型

- **额度配置**（`billing_account_credit_configs`）：limit / status / termsDays（账期天数）/ effectiveAt / expiresAt。变更全部写 `billing_account_credit_events` 审计（幂等键去重），新事件同时保存 old/new effectiveAt 和完整时态快照标记。
- **欠款事实**：钱包负余额（`account_wallets.balance_usd < 0`）即信用占用，不设第二资金账户。
- **可用余额** = 钱包余额 + 有效额度（状态 ACTIVE 且在生效窗口内，否则额度为 0），再与 workspace allowance 取 min。
- **扣费防护**：扣费事务对 credit config 行 `FOR UPDATE`，与管理端并发下调额度互斥；钱包扣减用 `balance >= amount - limit` 原子条件。
- **消费归因**：单笔扣费根据持锁钱包的 before/after 精确拆为实收、批准信用和未批准欠款。负余额部分写 `balance_consumption_allocations(source=ENTERPRISE_CREDIT)`；批准信用与未批准欠款分成独立行，不能共享账期。`recognized_revenue_usd=0`（实付资金核销时确认收入，见 §5）。
- **延迟结算**：可信 Gateway 用量按请求发生时间解析可证明的授信快照，并把 policyAt、termsDays 和 dueAt 冻结在批准信用分摊中。当前授信配置为 `ACTIVE` 时，发生后新增的额度不能覆盖旧请求；历史快照不完整时在任何资金写入前返回可重试失败，等待边界恢复，不能把“历史未知”伪装成可用信用。当前无授信配置，或配置为 `DISABLED` / `SUSPENDED` 时，企业按零信用预付费账户冻结资金；是否进入该路径只看账户锁内的当前配置，不查询授信历史。
- **未开通信用**：当前没有 config，或状态为 `DISABLED` / `SUSPENDED`，直接进入 `CURRENT_PREPAID`，不查询授信历史。当前配置为 `ACTIVE` 但额度为 0 或不在有效期时，仍需先完成发生时策略证明，再以有效额度 0 处理。两种路径都不授予企业账期；超出已充值余额的已交付权威用量形成未批准欠款并立即关闸。

### 状态语义

| 状态 | 有效额度 | 含义与预期用法 |
|------|---------|--------------|
| `ACTIVE` | limit | 正常授信 |
| `SUSPENDED` | 0 | **冻结（可恢复）**：欠款和配置保留，新信用消费停止，还款/充值不受影响。账期逾期由 worker 自动进入此态（event reason=`overdue_auto_suspend`）；回款核销后由管理员人工恢复 ACTIVE |
| `DISABLED` | 0 | **关闭授信（长期）**：明确终止授信关系。行为与 SUSPENDED 相同，语义区别在运营流程：DISABLED 不应被自动流程改回 |

企业账户存在欠款（钱包为负）时**不应**停用/软删账户——先追回欠款再关户；账户软删由管理端流程把关（billing 侧不提供带欠款删除的接口）。

## 5. 还款核销（settlement）

授信闭环 = 消费挂账 → 还款填坑 → 核销确认收入 → 逾期自动暂停。

### 5.1 触发：注资填坑

任何让企业钱包"从负往上走"的注资，其**填坑部分**（把负余额拉回 0 的那部分金额）触发核销：

| 路径 | 场景 | 收入口径 |
|------|------|---------|
| `rechargeWithBonus` | 用户自助充值 | 实付部分确认收入 |
| `adjust`（正向） | **公对公转账：财务收款后管理员后台代充** | 全额按实付确认收入 |
| `issueVoucher` | 代金券 | 不确认收入（赠金） |
| `creditBonus` | 充值赠送 | 不确认收入（赠金） |

个人账户（CreditPolicy 透支）不适用以上任何逻辑。

### 5.2 核销动作（同一事务内）

1. 按**桶优先级 + 桶内 FIFO** 冲抵未核销的 `ENTERPRISE_CREDIT` 分摊：`settled_usd` 累加，追平 `amount_usd` 时写 `settled_at`。

   候选集的过滤条件只有 `billing_account_id` + `source` + `settled_at IS NULL`，**没有任何时间条件**。三个桶严格串行，前一桶取空才动下一桶，FIFO（`ledger_sequence ASC, id ASC`）只在桶内成立：

   | 桶 | 谓词 | 含义 |
   |----|------|------|
   | B1 | `funding_classification_complete AND unapproved_debt_usd > 0` | 未批准欠款 |
   | B2 | `NOT funding_classification_complete` | 历史未分类（分类开关上线前的存量行） |
   | B3 | `funding_classification_complete AND approved_credit_usd > 0` | 账期应收 |

   **跨桶不看账龄**：一笔刚发生的 B1 会排在任意老的 B2/B3 之前。这是有意的 —— B1 优先才能让一笔还款立刻解掉 `debt_open` 关闸（见 `releaseRepaidGatewayBalanceDebtRestrictions`），否则客户必须还清全部历史欠款才能恢复服务。

   由此有两个必须向财务讲清的推论：

   - **「某日之后的消费没参与分摊」通常不是漏了，而是钱不够。** 核销总额恒等于本次填坑额（`min(入金, |负余额|)`，有 `BALANCE_DEBT_SETTLEMENT_POSTCONDITION_FAILED` 硬校验），所以队列必然停在某个 `ledger_sequence` 上，那个位置对应的日期只是水位线。
   - **部分还款解不掉临近的到期日。** `enterprise-credit-overdue-worker` 的挂起判定取 `min(frozen_due_at, legacy_due_at)`，而 `frozen_due_at` 来自 B3；B3 排在最后，所以只付一部分钱会全部进 B2，B3 上那个即将到期的日子一动不动。
2. 实付填坑部分累加 `recognized_revenue_usd`（赠金填坑不产生收入）——财务报表直接复用现有 recognizedRevenue 汇总口径。
3. 写 `enterprise_credit_settlements` 明细（还款流水 ↔ 分摊，含实付/赠金拆分），可审计追溯。
4. **还款不铸造可消费额度**：充值/代金券 grant 的 `remaining_amount_usd` 只保留浮出水面的部分（发生额 granted 保持全额，供财务对账）。

### 5.3 兜底、政策发布恢复与账期（`enterprise-credit-overdue-worker`，默认每分钟）

1. **残留核销**：钱包欠款已回正但分摊仍挂账（未接入核销的注资路径/存量数据）→ 补核销差额（`trigger=SWEEP`，`repayment_transaction_id=NULL`）。先于逾期判定执行，避免误停。
2. **政策发布恢复**：扫描与 config 当前 `policyRevision` 一致、尚未确认边界或尚未写 `policy_fanout_enqueued_at` 的事件（admin / overdue / bootstrap 全覆盖）。先安全确认第二事务边界，再将账户下每个 Key 的余额投影交给 Publisher 或其 durable job，成功后才写 marker。旧 revision 不回写当前投影；进程在 tx1、HTTP 响应或 Key 枚举任一点退出，下一轮都会重试。
3. **账期逾期**：config `ACTIVE` + 锁后钱包仍为负 + 锁后重读的未核销分摊到达其发生时冻结的 `credit_due_at` → 自动置 `SUSPENDED` + 审计事件 + `alert_events` 记录 + key-balance fanout。只有迁移前、没有完整快照的存量分摊才按锁后当前 `termsDays` 计算。

   **合同到期日 ≠ 服务挂起日**：`ENTERPRISE_CREDIT_OVERDUE_GRACE_HOURS`（默认 `0`，非法/负值一律回落 `0`）只推迟挂起动作，不改变 `credit_due_at`。审计事件的 note 与日志同时记 `dueAt` 和 `enforceAt`，两者不可混用于对外沟通。

   **授信恢复即恢复服务**（2026-09-02 起）：运营把 config 改回 `ACTIVE` 后，
   `releasePolicyRestoredGatewayBalanceDebtRestrictions` 立刻解除 `debt_open` 关闸，
   **不等实付资金到账** —— 业务已明确「能不能用」与「有没有还钱」解耦。
   触发点两处：管理端改 config 的路径（fanout 之后、返回之前，best-effort）
   与 overdue worker 每轮兜底（幂等，判据全部重读）。
   `release_reason` 用 `enterprise_credit_policy_restored`，**不得**复用
   `balance_unapproved_debt_repaid` —— 后者断言「已被实付核销」，这条路径并没收到钱。
   放行判据：授信当前有效（含 `termsDays>0` 与生效窗口）、`policy_boundary_complete`、
   当前 revision 的 `policy_fanout_enqueued_at` 非空、且
   **额度 ≥ 钱包欠款 + 在途预占**（`ACTIVE`/`MANUAL_REVIEW` 预占的 `reserved − collected`）。
   刻意不复用 `getWorkspaceBalanceSnapshot` 的 `creditRemainingUsd`：那个量是
   `max(0, limit − min(limit, |钱包负数|))`，欠款超额度时恒为 0，
   拿它当覆盖证明会在最该拦住的超额场景下 fail-open，且它对预占零引用。
   混有个人透支（`NEGATIVE_BALANCE`）欠款的关闸整条不放行。
   被解封的那些 allocation **仍是 `unapproved_debt`**（留在 B1），下一笔还款照旧优先冲它们；
   本路径一个财务字段都不写。

   **催收豁免**：`ENTERPRISE_CREDIT_OVERDUE_RESTORE_DEFERRAL_HOURS`（业务定 7 天 = 168，
   代码默认 0 = 不豁免 = 最严）。只有「人工把授信改成 `ACTIVE`」才给豁免
   （`reason=overdue_auto_suspend` 或 `newStatus≠ACTIVE` 一律不给，否则 worker
   自己挂起后会给自己发豁免）。窗口从当前 revision 的 credit event `created_at` 起算，
   靠 `@@unique([billingAccountId, policyRevision])` 保证唯一取值，无需新增列。
   挂起条件因此变成 `now >= max(dueAt + grace, restoreDeferredUntil)`。
   ⚠️ **已知且被接受的代价**：运营每次碰一下授信配置都会 bump revision 并重启该窗口，
   业务明确选择不限次数 ⇒ 逾期风控可被每 7 天续一次、无限期绕过，
   唯一护栏是每条 event 上的 `actor_id`。要收紧就加「总计不超过 N 小时」或「最多 N 次」。

   **改 `terms_days` 不追认已发生的消费**：`credit_due_at` 是发生时冻结的，调大账期只对之后的新消费生效，已冻结的到期日不变，挂起该来还是来。

4. **观测**（这四个指标在 2026-08-28 的静默断服事故中是缺失的）：
   - `ruidong_enterprise_credit_overdue_accounts{phase}` — 临近挂起的账户数，`phase ∈ due_7d|due_3d|due_1d|enforceable`。**告警规则以此为准**，阈值判定与去重交给 Alertmanager，应用侧不自建预警去重表。
   - `ruidong_enterprise_credit_enforcement_earliest_seconds` — 距最近一个挂起时刻的秒数（已可挂起时为负）。无待挂起账户时输出一年的哨兵值，看板用。
   - `ruidong_billing_debt_open_restrictions_active` / `ruidong_billing_debt_open_oldest_age_seconds` — 当前被 `debt_open` 关闸的客户数与最老那条的年龄，**即客户可见的断服时钟**。不限定成因：无配置 / `SUSPENDED` / `DISABLED` / 零额度 / 过期额度 / 额度耗尽都会建立同样的关闸。
   - `ruidong_enterprise_credit_overdue_suspend_total{outcome}` — `suspended` / `deferred_by_grace`。

环境变量：`ENTERPRISE_CREDIT_OVERDUE_ENABLED`（默认开）、`ENTERPRISE_CREDIT_OVERDUE_INTERVAL_MS`（默认/生产推荐 `60000`，下限 `60000`）。该 interval 同时是额度下调发布的崩溃恢复周期，生产不得调大；正常 admin 请求仍即时 enqueue。

### 5.4 已知边界

- 网关侧限额靠 key-balance fanout 异步下发，同步间隙内已经放行的请求仍可能产生供应商成本。Billing 不得通过 `BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE` 向账户创建额外信用；该变量生产必须保持 `false`。
- 企业仅在信用配置 `ACTIVE`、位于生效期且未被账期规则暂停时使用授信额度和账期。没有有效信用配置的企业账户按个人预付费账户方式处理：只能使用该企业账户已充值余额，不享受企业授信或账期；由于企业主体可能有多名成员，也不会继承任一成员的个人用户级透支策略。
- `QUARANTINED` 的 BALANCE 用量会形成待核验 hold，并从后续授权与 Publisher 可用余额投影中扣除；可额外配置账户级待核验请求数和敞口上限，超限后 fail-closed。
- 权威用量以 Gateway 签名的 `start_time` 和 Billing DB 不可变 `first_received_at` 共同限定发生时间。显式配置正整数 `BILLING_GATEWAY_CLOCK_MAX_SKEW_MS=Δ` 后，可能区间为 `[start_time-Δ, min(start_time+Δ, first_received_at)]`；长请求或 Kafka 延迟不会被误判为慢时钟，只有 `start_time-Δ > first_received_at`（Gateway 快时钟越界/空区间）失败。当前配置为 `ACTIVE` 时，缺失、0、非法 Δ 或区间跨 policy revision / 生效窗口都属于“历史不可证明”，结算进入可重试状态且不得产生资金结果。当前配置不存在或为 `DISABLED` / `SUSPENDED` 时，Billing 直接按零信用预付费处理，不以历史事件作为门槛；此时 `approvedCreditUsd=0`、账期为空，时钟窗口不会改变授信结果。账期 `dueAt` 使用区间上界，避免因时钟不确定性提前催收。
- 当前授信配置为 `ACTIVE` 时，授信边界使用持锁后的 `policyDecisionAt` 与提交后第二事务确认的 `policyEffectiveBoundaryAt`，不使用事务开始时刻的 `created_at`。两者之间（含毫秒精度不确定窗口）统一按历史不可证明处理；不可变 credit event 历史无法完整重建时同样 fail-closed 并等待恢复，不得借用后来开通的信用，也不得直接落成永久零额度债务。`CURRENT_PREPAID` 是明确例外：当前无配置或为 `DISABLED` / `SUSPENDED` 已直接证明当前不可借款，不以历史完整性作为门槛。永久 `DEBT_OPEN` 只允许两类证据化结果：（a）`CURRENT_PREPAID` 已由当前配置证明，权威用量超过预付现金；（b）当前 `ACTIVE` 的发生时策略已完整证明，权威用量超过当时现金与有效额度。两类结果都必须对 Billing Account 持久关闸；发生时有效的账期按批准信用分摊行冻结到期日，由 `enterprise-credit-overdue-worker` 执行。
- 部署新代码不会自动重放既有 `FAILED:insufficient_balance` 或不可信历史事件；存量处理必须通过证据化 dry-run、审批和幂等 repair，禁止静默补扣。
- 已提供授信窗口不可证明、政策恢复失败和最老恢复年龄指标；信用利用率与未批准欠款金额的独立业务仪表盘仍需在部署侧配置。
- 大额授信调整暂无双人复核（有意后置）。

## 6. 生产部署与存量 bootstrap runbook

迁移必须保持编号顺序，不能把 `00114`/`00115` 合成一个事务：

1. 部署新二进制可读的新列与 `00107` 强 shape 约束；`00108`～`00110`、`00113` 均是一条独立 `CREATE INDEX CONCURRENTLY`。
2. `00111` 先安装 mixed-version DB trigger。旧二进制若绕过 revision 协议修改额度，会被数据库拒绝；此后禁止回滚到旧二进制。
3. `00114` 在表锁下把 revision 0 当前配置写成 revision 1 pending event：old snapshot 固定为 NULL，current config 作为 new snapshot。`policyDecisionAt` 之前和 A/B 间隔内的历史请求均不追认信用、额度为 0。
4. `00115` 必须在 `00114` 提交后单独运行，用新的 DB clock 确认 event/config boundary，并 validate revision-zero guard。仅确认边界之后的请求可使用当前信用。
5. 迁移后先保持 Gateway settlement shadow，核验以下 SQL 结果均为 0，再灰度资金影响：

```sql
SELECT count(*) FROM billing_account_credit_configs WHERE policy_revision = 0;

SELECT count(*)
FROM billing_account_credit_configs config
LEFT JOIN billing_account_credit_events event
  ON event.billing_account_id = config.billing_account_id
 AND event.policy_revision = config.policy_revision
WHERE event.id IS NULL
   OR NOT config.policy_boundary_complete
   OR NOT event.policy_boundary_complete
   OR config.policy_effective_boundary_at IS DISTINCT FROM event.policy_effective_boundary_at;

SELECT count(*)
FROM billing_account_credit_configs config
JOIN billing_account_credit_events event
  ON event.billing_account_id = config.billing_account_id
 AND event.policy_revision = config.policy_revision
WHERE event.policy_fanout_enqueued_at IS NULL;
```

回滚只允许回滚应用流量并保留 additive schema/trigger；不得降 revision、删除历史事件或回到会少算/绕过 revision 的旧镜像。出现异常时暂停企业信用路由或将相关账户按预付费 fail-closed，修复后向前发布。

## 7. 指标与告警门槛

- `ruidong_gateway_credit_policy_window_unavailable_total{reason}` 仅使用固定 reason。`not_configured|invalid|invalid_occurrence|invalid_window|fast_out_of_bounds|history_unavailable` 任一 5 分钟增量大于 0 立即告警；`window_crosses_policy` 增量大于 0 告警到 Billing 值班并对对应结算做证据复核。指标 label 禁止加入 account/request。
- `ruidong_enterprise_credit_policy_recovery_oldest_age_seconds > 120` 持续 2 分钟立即告警（超过两个 60 秒恢复周期）；`rate(ruidong_enterprise_credit_policy_recovery_total{outcome="failed"}[5m]) > 0` 立即告警。
- 告警必须在测试 Alertmanager 实际收到测试事件后才算上线；只存在 PromQL 或 `/metrics` 可见不算完成。
