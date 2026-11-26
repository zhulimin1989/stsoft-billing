# 折扣活动系统 — E2E 测试矩阵（Phase 10）

部署到 `saas-admin-test` 后按此矩阵跑一遍。

## 0. 前置

1. 后端 admin 已跑迁移：
   ```bash
   cd /opt/codesphere-admin-saas/apps/api
   pnpm prisma migrate deploy
   ```
2. 管理员后台已创建 2 个测试活动 + 3 个测试促销码（见"测试数据"节）。
3. Stripe Dashboard 切到 Test mode。
4. `.env` 里：`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PUBLISHABLE_KEY` 就位。

## 1. 测试数据（用 admin UI 创建）

### Campaigns
| 名字 | plan | scope | period | usd/monthly | usd/yearly | 备注 |
|------|------|-------|--------|-------------|------------|------|
| 黑五大促 | Pro | all | both | 1200 (原价 1900) | 1000 (原价 1500) | 测算法 |
| 新用户首月 1 美刀 | Pro | new_users | monthly | 100 | 0 | 测 scope |
| 老用户感恩 30% OFF | Pro | old_users | monthly | 1330 | 0 | 测 scope |

### DiscountCodes
| code | 类型 | 值 | duration | 限次 | 备注 |
|------|------|----|----|------|------|
| `SAVE20` | percent_off | 20 | once | maxUsesPerUser=1 | 首单 20% |
| `LOYAL10` | percent_off | 10 | forever | maxUsesPerUser=0 | 续期都打 |
| `FIVEOFF` | amount_off | 500 (usd) | once | maxUses=100 | 固定金额 |

## 2. 矩阵

### A. 仅活动

| 用例 | 输入 | 期望订单 | Stripe 检查 |
|------|------|---------|-----------|
| A1 card + usd + monthly | Pro / card / usd / monthly（新用户） | finalAmount=100 cents（首月 1 美刀活动命中） | subscription 有 discount，次月账单 =1900 |
| A2 alipay + usd + monthly | 老用户 + alipay + usd | finalAmount=1330（感恩 30%） | payment_intent amount=1330，一次性 |
| A3 card + sgd + yearly | 老用户 + sgd + yearly | 看黑五活动（sgd 未配 → 回落到原价） | — |
| A4 card + usd + yearly | 新用户 + usd + yearly | finalAmount=12000（黑五年付 1000×12） | subscription amount_total=12000 |

### B. 仅促销码

| 用例 | 输入 | 期望 |
|------|------|------|
| B1 SAVE20 | Pro + usd + monthly + 码 SAVE20 | 原价 1900 → 1520 |
| B2 FIVEOFF | Pro + usd + monthly + 码 FIVEOFF | 1900 → 1400 |
| B3 FIVEOFF 错币种 | Pro + sgd + monthly + FIVEOFF | validate 端点返 `{valid:false, reason: "仅适用于 USD"}` |
| B4 LOYAL10 续期 | Pro + usd + monthly + LOYAL10 | 首月 1710；模拟 invoice.paid cycle → 续期应用 10% = 1710 |
| B5 SAVE20 重复使用 | 同用户第二次下单带 SAVE20 | validate 返 `{valid:false, reason: "次数"}` |

### C. 活动 + 码叠加（取最便宜）

| 用例 | 输入 | 期望 winner |
|------|------|-----------|
| C1 | Pro + usd + monthly + SAVE20（20%→1520）vs 黑五（1200） | 黑五胜 1200 |
| C2 | Pro + usd + monthly + FIVEOFF（-500→1400）vs 黑五（1200） | 黑五胜 1200 |
| C3 (tie) | 构造活动价 1520 + SAVE20 也 1520 | Campaign 胜（tie-break） |

### D. 限制

| 用例 | 输入 | 期望 |
|------|------|------|
| D1 firstTimeOnly | 已买过 Pro 的用户，带首次活动 | 不命中，走原价 |
| D2 new_users | 老用户（已有付费历史）点"新用户首月 1 美刀" | preview 返 null |
| D3 maxUsesTotal 达上限 | 设个 maxUsesTotal=1 的活动，第二个用户下单 | 不命中 |

### E. Stripe Coupon 故障

| 用例 | 输入 | 期望 |
|------|------|------|
| E1 | 在 Stripe Dashboard 手动删除某 coupon，再用该活动下单 | 前端报错"活动配置异常..."（不允许 fallback） |
| E2 | 关闭 Stripe 服务 key 再创建活动 | 创建接口 5xx，Campaign 被禁用 |

### F. 续期按原价（关键）

| 用例 | 输入 | 期望 |
|------|------|------|
| F1 | 用活动价订阅 → 28 天后 Stripe 触发 invoice.paid subscription_cycle webhook | 扣 1900（原价），不是 1200 |
| F2 | 用 SAVE20 (once) 订阅 → 续期 | 续期扣 1900 |
| F3 | 用 LOYAL10 (forever) 订阅 → 续期 | 续期扣 1710 |

### G. 退款

| 用例 | 输入 | 期望 |
|------|------|------|
| G1 | 用活动价订阅，马上退款 | 退 1200（实付）；redemption 保留（审计用） |

## 3. Webhook 本地测试

```bash
stripe listen --forward-to http://localhost:3000/api/payment/webhook
stripe trigger invoice.paid --override invoice:subscription=<sub_id>,invoice:billing_reason=subscription_cycle
```

## 4. 监控检查

- `campaign_redemptions` 表行数增长 = 实际使用活动次数
- `discount_code_redemptions` 表 + `discount_codes.current_uses` 保持一致
- `orders.original_amount_cents` 和 `amount_cents` 差值 = `discount_amount_cents`

## 5. 已知限制

- PromoCode 的 `amount_off` 强制币种匹配 — 跨币种（如 `FIVEOFF` usd 给 sgd 订单）直接拒绝；运营如果要支持多币种同 code，需要创建多个 code 或改造成币种聚合。
- Campaign 删除是软禁用（保留历史 redemption）。强制硬删会破坏 FK。
- 老用户 / 新用户判定仅看 `user_subscriptions` 表中是否存在任何 ACTIVE/EXPIRED/CANCELLED —— 未完成的 PENDING 订单不算"购买过"。
