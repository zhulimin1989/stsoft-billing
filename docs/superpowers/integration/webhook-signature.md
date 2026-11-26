# Webhook 签名校验（codesphere-saas 侧实现说明）

Admin 发往 codesphere-saas 的所有 webhook（`notifyProductSaas`、`notifyCreditChanged`）
从 Phase 1 T-10 开始带 HMAC-SHA256 签名。

## Header

| Header | 说明 |
|---|---|
| `X-Sync-Token` | 原共享 token（不变） |
| `X-Webhook-Timestamp` | 发送方 unix seconds |
| `X-Webhook-Signature` | `hex(hmac_sha256(SYNC_WEBHOOK_SECRET, "${ts}.${raw_body}"))` |

## 校验步骤

1. 读 `X-Webhook-Timestamp`，拒绝相差 > 300s 的请求（防重放）
2. 读原始 body（`raw_body`，不是 JSON 解析后的 dict）
3. 用同一 `SYNC_WEBHOOK_SECRET` 算出 `expected = hmac_sha256(secret, f"{ts}.{raw_body}")`
4. 用 `hmac.compare_digest(expected, got)` 做常量时间比较

## Python 参考实现（给 codesphere-saas 团队）

```python
import hmac
import hashlib
import time
from fastapi import Request, HTTPException


async def verify_webhook(request: Request, secret: str, max_age: int = 300) -> None:
    ts = request.headers.get("x-webhook-timestamp", "")
    sig = request.headers.get("x-webhook-signature", "")
    if not ts or not sig:
        raise HTTPException(401, "missing signature headers")

    try:
        ts_int = int(ts)
    except ValueError:
        raise HTTPException(401, "invalid timestamp")

    if abs(time.time() - ts_int) > max_age:
        raise HTTPException(401, "timestamp outside window")

    raw = await request.body()  # bytes — exact bytes Admin sent
    expected = hmac.new(
        secret.encode(),
        f"{ts}.".encode() + raw,
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, sig):
        raise HTTPException(401, "signature mismatch")
```

注意：`raw_body` 必须是**原始字节**，不能 `json.dumps(json.loads(...))` 重新序列化（key 顺序、空格会变）。

## Secret 配置

- Admin 侧：`apps/api/.env` 里的 `SYNC_WEBHOOK_SECRET`
- codesphere-saas 侧：同一个值（命名可自选，如 `ADMIN_WEBHOOK_SECRET`）
- 未设置 `SYNC_WEBHOOK_SECRET` 时 Admin 回退到 `SYNC_TOKEN` — 过渡期可用，正式上线必须分开

## 向后兼容

Admin 始终发送签名 header，即使 secret 未配置（签名会用 fallback 算出）。
codesphere-saas 可以先实现"存在 header 则校验、不存在则跳过"，确保新旧代码混跑不阻断。

## 回滚方案

如果验签把合法流量挡住：
1. 先把 codesphere-saas 的校验改为 "log-only 模式"，不 401
2. 观察日志里的 mismatch 记录，找出原因（raw body 解析、secret 不一致、时间漂移）
3. 修好后重新开启强制校验
