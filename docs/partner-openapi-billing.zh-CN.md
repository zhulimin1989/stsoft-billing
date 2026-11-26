# Partner OpenAPI 账务查询接口

Base path: `/partner/v1`

本文档面向接入 Codesphere Partner OpenAPI 的外部 SaaS。账务查询接口使用产品接入令牌鉴权，产品身份由令牌推导，外部请求不要传 `productId` 或 `productSlug`。

## 鉴权与范围

- 请求头：`Authorization: Bearer <product integration token>`，也兼容 `x-product-token` / `x-billing-product-token`。
- 必填 query：`userId`。
- 条件必填 query：`tenantId`。只有 self-operated `CODING_PLAN` 的 user-only 主体可以省略；服务端会解析 provision 时建立的产品专属 personal tenant 绑定。其他产品省略时返回 400。
- 产品范围：只使用 token 解析出的当前产品；请求 query/body 中出现 `productId` 或 `productSlug` 会返回 400。
- `userId` / `tenantId` 是当前产品自己的外部 ID；服务端通过产品绑定解析内部主体，不接受未绑定的全局 ID。
- 所有 query 都拒绝未声明字段，字段拼写错误返回 400。

## P0 接口

### GET `/partner/v1/billing/current-subscription`

查询当前用户/租户在当前产品下的订阅。

Query:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 外部 SaaS 已镜像到 billing 的用户 ID |
| `tenantId` | 条件必填 | 外部 SaaS 已镜像到 billing 的租户 ID；仅 self-operated `CODING_PLAN` user-only 可省略 |

返回 `data` 包含 `productId`、`billingMode`、`fulfillmentMode`、`planId`、`planName`、`billingPeriod`、`monthlyCredits`、`status`、`expiresAt` 等字段。

### GET `/partner/v1/billing/credits`

查询当前产品下的积分池。

Query:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 用户 ID |
| `tenantId` | 条件必填 | 租户 ID；仅 self-operated `CODING_PLAN` user-only 可省略 |
| `entitlementId` | 否 | CodingPlan 指定权益 ID；必须属于当前 token 产品 |

返回 `quotaCredits`、`bonusCredits`、`grantCredits`、`totalCredits`、`usedThisMonth`、`usedThisCycle`、`billingCycleStart`。

### GET `/partner/v1/billing/credits-summary`

查询订阅与积分总览，供余额卡片和订阅页展示。

返回 `subscription`、`credits`，并将 `credits` 的核心字段同步展开到 `data` 顶层，便于前端直接读取 `totalCredits`、`usedThisMonth` 等字段。

### GET `/partner/v1/billing/credit-transactions`

查询当前产品下的积分流水。

Query:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 用户 ID |
| `tenantId` | 条件必填 | 租户 ID；仅 self-operated `CODING_PLAN` user-only 可省略 |
| `entitlementId` | 否 | CodingPlan 指定权益 ID |
| `page` | 否 | 默认 1 |
| `pageSize` | 否 | 默认 20，最大 100 |

返回分页结果。团队主体返回该团队订阅的流水，query `userId` 用于解析和授权账务主体，不会把结果缩窄为该 actor 的个人流水。每条流水包含原始 `quotaAfter` / `bonusAfter`，并额外返回 `balanceAfter = quotaAfter + bonusAfter`。流水中的 `userId` 表示实际消费 actor，并按当前产品的外部用户绑定返回；历史流水无法证明外部 actor 时返回 `null`，不会回退泄漏内部用户 ID。

## P1 接口

### GET `/partner/v1/billing/transactions`

查询当前产品下的余额/金额类流水。参数：`userId`、`tenantId`、`page`、`pageSize`。团队主体返回团队账务流水，query `userId` 不作为 actor 过滤条件。每条流水的 `userId` 表示当前产品命名空间中的实际 actor；无法映射时为 `null`。

### GET `/partner/v1/billing/daily-summary`

查询当前产品下的日维度消费汇总。

Query:

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 用户 ID |
| `tenantId` | 条件必填 | 租户 ID；仅 self-operated `CODING_PLAN` user-only 可省略 |
| `startDate` | 是 | UTC 自然日起始日期，严格 `YYYY-MM-DD` |
| `endDate` | 是 | UTC 自然日结束日期，严格 `YYYY-MM-DD`，包含当天 |
| `apiKeyId` | 否 | 指定 API Key |

所有日桶按 UTC `00:00:00Z` 切分，实际查询区间为 `[startDate 00:00:00Z, endDate 次日 00:00:00Z)`。`startDate` 不能晚于 `endDate`，查询跨度不能超过 366 天。

未指定 API Key、且查询主体为团队 owner 时，余额与积分沿用租户产品账本口径。指定 `apiKeyId` 或以团队成员身份查询时，汇总只统计该 Key/成员 TokenUsage 对应的真实余额分摊与积分 `CONSUME` 流水；`TokenUsage.costUsd` 仅是成本/计价事实，不会被当作余额实扣。

### GET `/partner/v1/billing/monthly-summary`

查询当前产品下的月维度消费汇总。参数：`userId`、`tenantId`、`year`。`year` 必须是完整四位数字，范围为 2020–2100。年份和月份均按 UTC 自然边界计算，每个月桶在当月 1 日 `00:00:00Z` 开始。
