# Partner OpenAPI 支付与订单接口

Base path: `/partner/v1`

本文档面向接入 Codesphere Partner OpenAPI 的外部 SaaS。支付/订单接口使用产品接入令牌鉴权，产品身份由令牌推导，外部请求不要传 `productId` 或 `productSlug`。

## 机器契约

仓库中的 `apps/api/openapi/partner-openapi.json` 是 Partner API 的稳定 OpenAPI 3.0 机器契约，包含 22 个操作的固定 `operationId`、请求参数、请求体、成功/错误响应和示例。

- 更新契约：`pnpm openapi:generate`
- 校验契约与代码同步：`pnpm openapi:check`
- 非生产环境默认通过 `/docs` 和 `/openapi.json` 提供；生产环境需显式设置 `OPENAPI_DOCS_ENABLED=true`

所有 query/body 都拒绝未声明字段。字段拼写错误不会被静默忽略，而是返回 400。

## OpenAPI 服务运行配置

下表中的默认值来自 `openapi-main.ts` 和产品令牌鉴权守卫：

| 环境变量 | 默认值 | 生产建议 |
| --- | --- | --- |
| `OPENAPI_TRUST_PROXY_HOPS` | `0` | `0` 表示 OpenAPI 直连、完全不信任客户端 `X-Forwarded-*`；正整数表示从实例到可信入口的**精确**代理跳数。生产环境必须按实际拓扑显式配置，不要扩大信任链，否则客户端可伪造转发 IP，绕过 IP 限流 |
| `OPENAPI_BODY_LIMIT_BYTES` | `1048576`（1 MiB） | Partner 请求都是小 JSON；没有明确业务需求不要提高 |
| `OPENAPI_REQUEST_TIMEOUT_MS` | `30000` | 与入口网关超时、Publisher 调用预算一起评估，并让外层超时略大于应用超时 |
| `OPENAPI_RATE_LIMIT_MAX` | `120` | 单 IP 全局窗口上限；按真实流量调优，不要关闭 |
| `OPENAPI_RATE_LIMIT_WINDOW` | `1 minute` | Fastify 时间窗口字符串，与上面的 IP 上限配套 |
| `OPENAPI_PRODUCT_RATE_LIMIT_MAX` | `600` | 单产品令牌窗口上限；和 IP 限流同时生效 |
| `OPENAPI_PRODUCT_RATE_LIMIT_WINDOW_MS` | `60000` | 单产品令牌窗口，单位毫秒 |
| `OPENAPI_DOCS_ENABLED` | 非生产启用；生产关闭 | 生产只在确实需要公开/受控提供文档时设为 `true` |
| `PARTNER_API_PUBLIC_BASE_URL` | 未设置时使用当前 Origin | 生产设置为外部 HTTPS 根地址，例如 `https://partner-api.example.com`；兼容兜底变量为 `OPENAPI_PUBLIC_BASE_URL` |

OpenAPI 公共面依赖 Redis 共享限流计数。Redis 限流后端异常时会 fail closed，返回 503；多实例生产环境不能依赖进程内计数。

## 鉴权

所有接口都需要产品接入令牌。推荐使用：

```http
Authorization: Bearer <product_integration_token>
```

也兼容：

```http
x-product-token: <product_integration_token>
x-billing-product-token: <product_integration_token>
```

如果请求 query 或 body 中包含 `productId` / `productSlug`，接口会返回 400。Partner OpenAPI 会从 token 自动识别当前产品，并按该产品做目录、下单和订单查询隔离。

## 目录汇总

### GET `/partner/v1/catalog`

返回当前 token 产品可见的目录汇总。

响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "products": [],
    "plans": [],
    "boosterPacks": [],
    "models": {},
    "modelAccess": {},
    "modelRoutePolicies": {},
    "channels": {}
  }
}
```

也可以继续按子目录查询：

- `GET /partner/v1/catalog/products`
- `GET /partner/v1/catalog/plans`
- `GET /partner/v1/catalog/booster-packs`
- `GET /partner/v1/catalog/models`
- `GET /partner/v1/catalog/model-access`
- `GET /partner/v1/catalog/model-route-policies`
- `GET /partner/v1/catalog/channels`

当前不发布 `catalog/model-pricing`，汇总目录也不返回价格。全局 `ModelPricing` 基价不等于某个 PAY_AS_YOU_GO 产品的实际结算价；真实扣费还会应用该产品当前有效的 pricing policy 与倍率。只有提供与结算引擎同源、带产品和生效时间语义的 effective quote 后，才会新增公开价格接口，避免展示价与扣费价不一致或泄露未发布基价。

当前也不发布组合套餐目录和 `BUNDLE` 创建能力。组合包现阶段没有一个同时满足续费、退款和崩溃恢复要求的 Partner 支付渠道；在 provider invoice line 到本地 item/effect 的持久映射完成前，不会向调用方展示“可发现但无法安全购买”的 SKU。历史组合包订单仍可通过订单查询读取。

`models` / `channels` 描述当前产品渠道实际可路由的模型能力，`modelAccess` 描述具体套餐与模型的倍率或准入覆盖。`modelAccess.items[].creditMultiplier` 是已有套餐—模型规则的权威积分倍率：`0` 表示该组合不扣积分，`1` 表示基础倍率，其他非负数按比例缩放积分消耗。`CODING_PLAN` 把缺失或停用的规则视为硬门禁；普通 `SUBSCRIPTION` 保留现有语义，缺少规则时按基础倍率 `1.0` 处理，因此不能仅凭 `modelAccess` 列表判断 `/models` 中的渠道能力不可用。接口不再用虚构的 `dailyLimit=-1` 代替倍率；周期配额以套餐的 `quotaRules` 为准。

`plans[].currency` 明确标识套餐价格币种。月付、季付和年付价格优先读取当前平台币种的 active `PlanPrice`，没有对应记录时才按下单服务相同的 legacy 规则回落到 Plan 顶层价格；因此目录展示和创建订阅订单使用同一套原价口径。

## 创建支付订单

### POST `/partner/v1/payment/create`

用于创建订单并获取支付页 URL。

### 请求字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 外部 SaaS 用户 ID。建议先通过 `/partner/v1/tenants/provision` 完成用户/租户镜像 |
| `tenantId` | 是 | 外部 SaaS 租户 ID。所有产品的支付写操作都必须显式绑定租户，以便 user-api 校验外部租户成员关系 |
| `orderType` | 否 | `SUBSCRIPTION` / `BOOSTER_PACK` / `RECHARGE`，默认 `SUBSCRIPTION` |
| `planId` | 条件必填 | `SUBSCRIPTION` 订单必填 |
| `boosterPackId` | 条件必填 | `BOOSTER_PACK` 订单必填 |
| `amountCents` | 条件必填 | `RECHARGE` 订单必填，单位为分/cents |
| `channel` | 是 | `STRIPE` / `ALIPAY` / `WECHAT`；是否可用以 `/payment/methods` 返回为准 |
| `billingPeriod` | 否 | 仅 `SUBSCRIPTION` 可传：`monthly` / `quarterly` / `yearly`；省略时由服务端按 `monthly` 处理 |
| `currency` | 否 | ISO 4217 三位币种，如 `usd`、`cny` |
| `idempotencyKey` | 是 | 调用方生成的幂等键；去除首尾空白后必须为 8–128 个字符，且只能包含字母、数字、`.`、`_`、`:`、`-`；同一业务订单的所有超时重试必须复用同一个值 |
| `successUrl` | 条件必填 | Stripe、Alipay 的产品级策略必填；只能使用 HTTP(S)，且其 Origin 必须在当前 token 产品的支付回跳白名单内 |
| `cancelUrl` | 条件必填 | Stripe 的产品级策略必填；只能使用 HTTP(S)，且其 Origin 必须在当前 token 产品的支付回跳白名单内 |

### 产品级支付回跳白名单

每个产品在 Billing Admin 的“产品接入配置”中独立管理支付回跳 Origin。Partner OpenAPI 根据 `Authorization` 中的产品接入令牌识别产品，并用该产品的配置校验 `successUrl` 和 `cancelUrl`。新增或更换 SaaS 域名时，只需更新产品接入配置，无需修改 Billing 环境变量或重启服务。

配置语义：

- 产品白名单为非空数组时，只允许数组内的 Origin，不会与 Billing 全局白名单合并。
- 产品白名单为空数组时，显式禁止所有支付回跳地址。
- 产品未配置（`null`）时，为了兼容历史产品，才使用 Billing 全局环境变量作为兜底。新的外部 SaaS 不应依赖该兜底。
- Origin 精确匹配协议、主机和端口。回跳 URL 可以携带业务路径和查询参数，但其 Origin 必须已配置。
- 生产域名应使用 HTTPS；HTTP 仅支持 `localhost`、`127.0.0.1` 和 `[::1]` 本地联调地址。

`successUrl` / `cancelUrl` 是用户支付完成或取消后，支付页在浏览器中跳回 SaaS 前端的地址。Webhook URL 是 Billing 后端通知 SaaS 后端的地址，两者用途、请求方向和安全配置都不同，不能互相替代。

外部 SaaS 后端调用 Partner OpenAPI 时必须在产品级策略要求时显式传入回跳地址。Partner 接口不会从 `Origin`、`Referer`、`Host` 或转发头推导回跳地址，因为这些传输头在断线重试时可能变化，不能进入稳定的幂等请求语义。产品级策略也不会退回 Billing 的全局 Stripe/Alipay 地址。

支付创建的 `tenantId` 一律不能省略。即使 self-operated `CODING_PLAN` 的免费/API Key provision 可以使用 user-only scope，购买前也必须先用显式 `tenant.id` 完成 provision，建立可由 user-api 校验的外部租户成员关系；否则创建订单返回 400。

每种订单只能提交对应的一个业务目标：`SUBSCRIPTION` 只能使用 `planId`，`BOOSTER_PACK` 只能使用 `boosterPackId`，`RECHARGE` 只能使用 `amountCents`；混入其他目标字段会返回 400。`RECHARGE.amountCents` 必须是整元对应的 cents 值（100 的倍数），并且不能超过 `2,147,483,600`，以保持在账务数据库的有符号 32 位整数边界内。`currency` 必须是三位英文字母，服务端统一转换为小写；当前单币种部署还会拒绝与平台币种不一致的值。

回跳字段按通道严格收口：Stripe 使用 `successUrl` 和 `cancelUrl`；Alipay 只使用 `successUrl`，传入 `cancelUrl` 会返回 400；WeChat 不接受这两个浏览器回跳字段。调用方必须在所有超时重试中发送相同请求体。

调用方看到和重试时始终使用原始 `idempotencyKey`。Billing 同时保留原始 key 供旧二进制回滚读取，并写入当前产品派生的不可逆唯一存储键。身份 V2 为不同产品建立不同的内部用户/租户，因此两个产品可以使用相同 caller key；identity migration 若发现同一个 legacy internal user 被多个产品共同证明归属，会先 hard-stop，要求完成身份和 user-global Grant 拆分后再部署。不能依赖 legacy 共享主体绕过旧的 `(userId, tenantId, idempotencyKey)` 回滚唯一约束。同一产品内，同 key 不同请求内容仍返回 409。

匹配的产品级幂等重放会先验证当前外部绑定、内部用户、租户、账务账户、产品范围和请求指纹，再读取持久化支付状态；它发生在当前套餐/加油包可用性、当前回跳白名单和购买资格检查之前。因此，渠道已经创建成功但 HTTP 响应丢失后，即使目标随后下架或白名单收紧，原请求仍可取回同一个 `payUrl`，而新订单继续受最新策略约束。重放不会再次执行购买资格校验，也不会新建渠道交易。

`PENDING` 且支付链接已就绪时，服务端返回原订单和可恢复的原 `payUrl`；渠道仍在初始化时返回 409，调用方应稍后继续使用同一个 key；终态订单返回原订单且 `payUrl` 为 `null`。支付链接采用加密存储，恢复窗口从订单创建时间起分别为 WeChat 2 小时、Stripe 24 小时、Alipay 15 天；窗口过期会把仍未支付的订单置为 `EXPIRED`，终态会清理恢复材料。

普通订阅退款按 `checkout:<orderId>:activation` 精确关闭本订单创建的周期，并从 `checkout:<orderId>` 积分 grant receipt 读取原 `subscriptionId` 和实际发放数；不会使用后来重购的当前订阅，也不会使用已被运营修改的套餐月额度。receipt 缺失或积分不足时进入退款补偿失败/人工处理，不能静默收口。Standalone `CODING_PLAN` 的续期、换档和供应商转售尚没有完整反向操作；自动退款安全闸会在调用渠道退款前拒绝，运营必须先核对并撤销延期、旧档/key 改绑或上游权益。

对于 `SUBSCRIPTION`，省略 `billingPeriod` 与显式传入 `monthly` 在幂等指纹中等价。

Stripe Checkout 的 customer email 取自当前产品的外部用户绑定快照，而不是依赖跨产品共享的内部用户邮箱。相同邮箱可以合法出现在多个产品绑定中；外部 SaaS 应通过 provision 更新各自产品的权威邮箱快照。

### 渠道不确定结果与回调绑定

- WeChat Native 下单超时、连接重置等“请求可能已送达”的异常会持久化为 `OUTCOME_UNKNOWN`，不会伪装成确定失败或释放为普通重试。相同 key 重试会先用原商户订单号查询：已支付则按回调事实结算，`NOTPAY` / `NOT_FOUND` 才使用完全相同的金额、币种、描述和原始 `time_expire` 重新调用下单。微信官方 Native 文档允许相同参数重入并返回新的 `code_url`：[Native 支付常见问题](https://pay.wechatpay.cn/doc/v3/merchant/4012791890)。
- Stripe 在本地持久化不可变的 Checkout Session ID、支付实例和创建时的 Checkout 模式。回调必须同时匹配验签实例、原 Session、金额、币种、支付状态和模式；同一实例的其他 Session 也不能结算该订单。
- 新订单中，Stripe 支持 `BOOSTER_PACK`、`RECHARGE`，以及以一次性 `payment` Checkout 结算的 `CODING_PLAN` 订阅；普通 `SUBSCRIPTION` 产品的循环订阅和 `BUNDLE` 不会出现在支付方式发现结果中，也不能创建。历史 `subscription` Checkout 回调仍按原 Session/subscription/invoice 台账精确处理，但 `invoice.paid` 自动续费在缺少可逆的账单行到本地权益映射期间会 fail-close，不会自动发放或延期权益。
- 若多个 Stripe 实例共享同一个 webhook secret，或多个 Alipay 实例共享验签无法区分的 app/public-key 组合，验签结果会携带全部等价实例 ID；订单绑定实例必须在该集合中。环境变量凭证只允许处理没有实例绑定的 legacy 订单。

### 订阅订单示例

```http
POST /partner/v1/payment/create
Authorization: Bearer <product_integration_token>
Content-Type: application/json
```

```json
{
  "userId": "user-123",
  "tenantId": "tenant-123",
  "orderType": "SUBSCRIPTION",
  "planId": "plan-pro",
  "channel": "ALIPAY",
  "billingPeriod": "monthly",
  "currency": "usd",
  "idempotencyKey": "saas-order-10001",
  "successUrl": "https://app.saas.example/billing/success"
}
```

### 充值订单示例

```json
{
  "userId": "user-123",
  "tenantId": "tenant-123",
  "orderType": "RECHARGE",
  "amountCents": 5000,
  "channel": "STRIPE",
  "currency": "usd",
  "idempotencyKey": "saas-recharge-10001",
  "successUrl": "https://app.saas.example/billing/success",
  "cancelUrl": "https://app.saas.example/billing/cancel"
}
```

### 响应示例

```json
{
  "code": 0,
  "message": "订单创建成功",
  "data": {
    "order": {
      "id": "order-123",
      "userId": "user-123",
      "tenantId": "tenant-123",
      "orderType": "SUBSCRIPTION",
      "productId": "token-derived-product",
      "planId": "plan-pro",
      "bundleSkuId": null,
      "boosterPackId": null,
      "amountCents": 1999,
      "status": "PENDING",
      "channel": "ALIPAY",
      "tradeNo": null,
      "paidAt": null,
      "createdAt": "2026-06-29T00:00:00.000Z"
    },
    "payUrl": "https://openapi.alipay.com/gateway.do?..."
  }
}
```

说明：

- `payUrl` 是外部 SaaS 需要跳转或展示给用户的支付页地址。
- Partner OpenAPI 会校验 `planId` / `boosterPackId` 是否属于当前 token 产品。
- `RECHARGE` 订单会自动使用 token 对应产品，不允许外部传 `productId`。

## 查询订单列表

### GET `/partner/v1/payment/orders`

订单列表会自动按当前 token 产品隔离。

### Query 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 用户 ID |
| `tenantId` | 条件必填 | 租户 ID；仅 self-operated `CODING_PLAN` user-only 可省略 |
| `page` | 否 | 默认 `1` |
| `pageSize` | 否 | 默认 `20`，最大 `100` |
| `status` | 否 | 订单状态；必须是下方“订单状态”列出的枚举之一 |
| `orderType` | 否 | `SUBSCRIPTION` / `BOOSTER_PACK` / `RECHARGE` / `BUNDLE` |

请求示例：

```http
GET /partner/v1/payment/orders?userId=user-123&tenantId=tenant-123&page=1&pageSize=20
Authorization: Bearer <product_integration_token>
```

响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "items": [],
    "total": 0,
    "page": 1,
    "pageSize": 20,
    "totalPages": 0
  }
}
```

## 轮询订单状态

### GET `/partner/v1/payment/orders/:id/status`

用于支付驻留页轮询订单支付和履约状态。

请求示例：

```http
GET /partner/v1/payment/orders/order-123/status?userId=user-123&tenantId=tenant-123
Authorization: Bearer <product_integration_token>
```

响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "status": "PENDING",
    "paidAt": null,
    "cancelReason": null
  }
}
```

订单状态：

- `PENDING`
- `PAID`
- `FULFILLING`
- `PARTIALLY_FULFILLED_REQUIRES_COMPENSATION`
- `COMPLETED`
- `FAILED`
- `CANCELLED`
- `EXPIRED`
- `REFUNDING`
- `REFUNDED`
- `REFUND_FAILED`
- `REFUND_COMPENSATION_FAILED`

## 查询订单详情

### GET `/partner/v1/payment/orders/:id`

请求示例：

```http
GET /partner/v1/payment/orders/order-123?userId=user-123&tenantId=tenant-123
Authorization: Bearer <product_integration_token>
```

响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": "order-123",
    "userId": "user-123",
    "tenantId": "tenant-123",
    "orderType": "SUBSCRIPTION",
    "productId": "token-derived-product",
    "planId": "plan-pro",
    "bundleSkuId": null,
    "boosterPackId": null,
    "amountCents": 1999,
    "status": "COMPLETED",
    "channel": "STRIPE",
    "tradeNo": "cs_test_xxx",
    "paidAt": "2026-06-29T00:05:00.000Z",
    "createdAt": "2026-06-29T00:00:00.000Z"
  }
}
```

## 取消订单（尚未开放）

Partner OpenAPI 当前不发布取消操作。正常下单在返回 `payUrl` 前已经创建渠道 Checkout/二维码/支付单；如果此时只把本地订单改成 `CANCELLED`，远端链接仍可能被支付，会制造资金孤单。三渠道统一取消必须先实现持久化的 query → close/expire → query-confirm Saga，并能恢复 outcome-unknown 和进程崩溃窗口；在该协议完成前，机器契约、当前产品 endpoint map 和控制器都不会暴露伪取消能力。

调用方应让未支付链接按渠道有效期自然过期，并继续轮询订单状态。对历史 `CANCELLED` / `EXPIRED` 订单的晚到支付，服务端会先以确定性事件键持久化 `PAYMENT/CRITICAL` 对账记录再 ACK；对账写入失败则不 ACK，让渠道重试，资金不会成为无记录孤款。

## 查询可用支付方式

### GET `/partner/v1/payment/methods`

支付方式会按当前 token 产品、产品计费模式、订单类型、币种、后台支付实例能力和产品支付回跳策略过滤。产品回跳白名单显式为空时，Stripe/Alipay 在创建阶段必然无法满足回跳合同，因此不会出现在发现结果中。Stripe 对普通 `SUBSCRIPTION` 产品的循环订阅不会返回；`CODING_PLAN` 的一次性订阅购买仍可返回。

### Query 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `orderType` | 否 | 默认 `SUBSCRIPTION` |
| `currency` | 否 | 如 `usd`、`cny` |

请求示例：

```http
GET /partner/v1/payment/methods?orderType=RECHARGE&currency=usd
Authorization: Bearer <product_integration_token>
```

响应示例：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "methods": [
      {
        "channel": "STRIPE",
        "label": "银行卡",
        "currency": "usd",
        "mode": "redirect"
      }
    ]
  }
}
```

## 推荐购买闭环

1. 外部 SaaS 调用 `POST /partner/v1/tenants/provision` 开通或镜像用户和租户。
2. 外部 SaaS 调用 `GET /partner/v1/catalog` 获取套餐、加油包和模型能力目录。
3. 外部 SaaS 调用 `POST /partner/v1/payment/create` 创建订单。
4. 外部 SaaS 使用响应中的 `payUrl` 跳转到 Stripe、Alipay 或 WeChat 支付页。
5. 支付驻留页轮询 `GET /partner/v1/payment/orders/:id/status`。
6. 支付完成后调用 `GET /partner/v1/payment/orders/:id` 刷新订单和权益状态。
7. 当前没有 Partner 取消接口；未支付订单让渠道链接自然过期，并继续处理可能到达的支付回调。只有三渠道持久关单 Saga 落地后才会新增该能力。

## 部署前历史权益数据闸

退款恢复依赖 Billing runtime 中的两个持久任务执行器。生产环境必须保持
`PROVIDER_REFUND_WORKER_ENABLED=true` 和
`STRIPE_SUBSCRIPTION_CANCELLATION_WORKER_ENABLED=true`；只部署 OpenAPI
进程或关闭这两个 worker，会让渠道结果未知、Stripe 退款待确认或本地补偿待续跑的订单停留在退款中。
轮询间隔、启动延迟和批量大小分别通过同名前缀的
`*_INTERVAL_MS`、`*_STARTUP_DELAY_MS`、`*_BATCH_SIZE` 调整。进入
`MANUAL_REVIEW` 的任务会写入 `CRITICAL` 告警，必须由运营核对渠道流水和本地权益后处理，不能直接把订单改成 `REFUNDED`。

Stripe 退款已成功但明细台账抓取失败时会写入 `CRITICAL` 告警；持久化的
Provider refund intent 或 Stripe subscription cancellation task 会保留精确
`refundId`。财务对账中的 Stripe ledger backfill 会按 `refundId` 精确扫描这两类
尚无退款台账的任务，并返回
`refundScanned`、`refundBackfilled`、`refundFailed`，可安全重复执行，不能仅补
Checkout/Subscription 收款台账而遗漏退款明细。

本次迁移不会猜测历史订单、权益周期和积分池之间的关系。`20260723000200_payment_checkout_recovery` 先提交纯扩展字段，随后独立的 `20260723000300_payment_effect_preflight` 执行 hard-stop。若首次 `migrate deploy` 在 003 以 `P0001` 停止，002 已提交，所以下面的 zero-row preflight 可以直接读取新锚字段；修复数据后先执行 `prisma migrate resolve --rolled-back 20260723000300_payment_effect_preflight`，再重试 `migrate deploy`。

下面三条查询必须全部返回 0 行；任何结果都代表旧数据没有可证明的撤销锚：

```sql
SELECT
  o.id AS order_id,
  o.status AS order_status,
  oi.id AS order_item_id,
  oi.status AS item_status,
  oi.plan_id
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.order_type = 'BUNDLE'
  AND oi.plan_id IS NOT NULL
  AND oi.product_id IS NOT NULL
  AND oi.status IN (
    'FULFILLED',
    'FULFILLING',
    'COMPENSATING',
    'COMPENSATION_FAILED'
  )
  AND o.status <> 'REFUNDED'
  AND NOT EXISTS (
    SELECT 1
    FROM subscription_periods sp
    WHERE sp.activation_idempotency_key =
      'bundle:' || o.id || ':item:' || oi.id || ':activation'
      AND sp.user_id = o.user_id
      AND sp.tenant_id = o.tenant_id
      AND sp.product_id = oi.product_id
      AND sp.plan_id = oi.plan_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM coding_plan_entitlements cpe
    WHERE cpe.order_id = oi.id
      AND cpe.user_id = o.user_id
      AND cpe.tenant_id = o.tenant_id
      AND cpe.product_id = oi.product_id
      AND cpe.plan_id = oi.plan_id
  );

SELECT
  rct.id,
  rct.order_id,
  rct.task_key,
  rct.action,
  rct.status
FROM refund_compensation_tasks rct
JOIN orders o ON o.id = rct.order_id
WHERE (
    (
      rct.action = 'CANCEL_SUBSCRIPTION'
      AND COALESCE(
        rct.payload ->> 'activationIdempotencyKey',
        rct.payload ->> 'initialActivationIdempotencyKey',
        ''
      ) = ''
    )
    OR (
      rct.action = 'CREDIT_DEDUCT'
      AND (
        COALESCE(rct.payload ->> 'subscriptionId', '') = ''
        OR COALESCE(rct.payload ->> 'bucket', '') = ''
        OR COALESCE(
          rct.payload ->> 'originalGrantIdempotencyKey',
          ''
        ) = ''
      )
    )
  )
  AND rct.status <> 'SUCCEEDED';

SELECT
  sp.id AS active_period_id,
  sp.user_id,
  sp.tenant_id,
  sp.product_id,
  sp.plan_id,
  sp.activation_idempotency_key
FROM subscription_periods sp
WHERE sp.status = 'ACTIVE'
  AND EXISTS (
    SELECT 1
    FROM orders candidate
    WHERE candidate.order_type = 'SUBSCRIPTION'
      AND candidate.user_id = sp.user_id
      AND candidate.tenant_id = sp.tenant_id
      AND candidate.product_id = sp.product_id
      AND candidate.plan_id = sp.plan_id
      AND candidate.status IN (
        'PAID',
        'FULFILLING',
        'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
        'COMPLETED',
        'REFUNDING',
        'REFUND_FAILED',
        'REFUND_COMPENSATION_FAILED'
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM orders owner_order
    WHERE owner_order.order_type = 'SUBSCRIPTION'
      AND owner_order.user_id = sp.user_id
      AND owner_order.tenant_id = sp.tenant_id
      AND owner_order.product_id = sp.product_id
      AND owner_order.plan_id = sp.plan_id
      AND owner_order.status IN (
        'PAID',
        'FULFILLING',
        'PARTIALLY_FULFILLED_REQUIRES_COMPENSATION',
        'COMPLETED',
        'REFUNDING',
        'REFUND_FAILED',
        'REFUND_COMPENSATION_FAILED'
      )
      AND (
        sp.activation_idempotency_key =
          'checkout:' || owner_order.id || ':activation'
        OR (
          LEFT(
            sp.activation_idempotency_key,
            CHAR_LENGTH(
              'stripe-renewal:' || owner_order.id || ':invoice:'
            )
          ) = 'stripe-renewal:' || owner_order.id || ':invoice:'
          AND SUBSTRING(
            sp.activation_idempotency_key
            FROM CHAR_LENGTH(
              'stripe-renewal:' || owner_order.id || ':invoice:'
            ) + 1
          ) ~ '^in_[A-Za-z0-9]+:order$'
        )
      )
  );
```

非零结果必须逐单核对渠道退款、实际订阅周期、积分流水和上游权益，并在部署前完成退款/权益收口或将订单转入明确的人工处理流程。只有能够证明唯一 order-period 所有权时，才能回填 `checkout:<orderId>:activation`；历史 Stripe 续期只接受严格的 `stripe-renewal:<orderId>:invoice:<in_xxx>:order` 锚。禁止仅凭“当前活动订阅”猜测历史关系。

## 错误处理要点

- `401`：缺少或使用了无效产品接入令牌。
- `400`：请求参数错误，或外部传入了 `productId` / `productSlug`。
- `403`：外部用户/租户没有当前 token 产品的有效绑定，或绑定关系不匹配。
- `404`：订单、套餐、组合包或加油包不存在，或不属于当前 token 产品。
- `409`：同一个 `idempotencyKey` 对应的请求内容不一致、已绑定失败订单，或支付渠道仍在初始化。初始化中的请求应稍后按原 key 重试。
- `429`：超过 IP 或产品令牌限流；遵循 `Retry-After` 响应头和响应体中的数值 `retryAfter` 秒数。
- `502` / `UPSTREAM_ERROR`：支付上游返回失败或无效响应；先查询订单状态，再按原 `idempotencyKey` 决定是否重试，不能生成新业务键。
- `503`：依赖服务或共享限流后端不可用。公共 OpenAPI 对限流存储故障 fail closed。
- `500`：未预期的服务端错误；不要盲目换用新幂等键。
