# [RETIRED] Gateway provider evidence OPEN 客户结算修复

状态：已于 2026-08-16 退役，禁止执行。

本文件原先描述 customer settlement v1 历史 anchor 的 evidence-only 修复流程。生产环境不存在该类 v1 anchor、receipt 或 funding reservation，当前发布采用纯 customer settlement v2，也不处理历史测试数据。因此旧 preview/apply 入口、请求体和逐条执行步骤已经移除，不能再作为 UAT 或生产操作手册使用。

## 当前 v2 合同

- Gateway `prompt_tokens` 是总输入（gross input），满足 `gross input = fresh input + cache read + cache write`；Anthropic 上游原始 `input_tokens` 仅表示 fresh input。
- 上游未回传 cache read/write 数量时按 0；显式数值在非负整数、total 和 cache 分桶不变量成立时保留。
- 客户结算 basis 仅有 `NORMALIZED_EXACT` 和 `CUSTOMER_PROTECTIVE_ZERO`。
- cache 价格独立于本次数量冻结，数量为 0 不会把已配置价格冻结成 `null`。
- provider evidence 可以保持 `INCOMPLETE/OPEN`，但纯审计缺陷不会创建账户 restriction，也不会改变已证明的客户金额。

## 退役边界

- 不得根据本文件调用任何历史 preview、reconcile 或 apply 入口。
- 不得把旧 anchor、旧 basis 或缺失 policy 字段重新解释为 v2。
- 不得通过修改 production anchor、receipt、TokenUsage、ledger 或客户余额处理非生产旧数据。
- 测试或 UAT 如仍有 v1 数据，应先停止 Billing consumer，再通过独立、明确审批的非生产数据清理或环境重建处置；该动作不属于本 runbook。
