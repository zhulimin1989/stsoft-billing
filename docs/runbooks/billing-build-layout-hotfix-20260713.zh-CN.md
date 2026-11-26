# Billing 构建产物布局修复上线手册（2026-07-13）

## 1. 上线目标

本次只修复 `codesphere-billing` 的 TypeScript 构建边界和镜像启动入口，不修改计费、余额、
支付或数据库迁移逻辑。

故障表现：`credit-balance-ledger-replay.spec.ts` 从 `src/` 跨目录导入 `scripts/`，TypeScript
据此把公共源码根目录推断到 `apps/api/`，导致入口从预期的 `dist/billing-main.js`、
`dist/openapi-main.js` 下沉为 `dist/src/billing-main.js`、`dist/src/openapi-main.js`。
镜像仍按原入口启动，因此会在启动阶段报 `MODULE_NOT_FOUND`。

修复分支：`fix/billing-build-rootdir-20260713`。

当前修复基线为 `origin/test@5dace82`。在该未修改基线上，完整 `pnpm test` 已存在
`referrals.service.spec.ts` 的 2 条失败（`prisma.referralClick.groupBy` mock 缺失）。本修复的
定向测试、typecheck 和生产 build 均通过，但现有 Docker Actions 会在推镜像前执行全量测试，
因此必须先由对应负责人修复这项既有测试基线，流水线才能产出新镜像；不得跳过测试发布。

## 2. 本次代码变更

1. 把旧 Redis 余额值解析函数移入 `src/billing/credit-balance-ledger-replay.ts`。
2. spec 和回填脚本共同引用 `src` 内的纯逻辑函数，消除 `src -> scripts` 反向依赖。
3. 新增生产专用 `apps/api/tsconfig.build.json`，固定 `rootDir: "./src"`，并从生产编译排除
   spec/test；日常 typecheck 仍继续覆盖测试源码。
4. `apps/api` 的 build 命令增加产物门禁：
   - 必须存在 `dist/billing-main.js`；
   - 必须存在 `dist/openapi-main.js`；
   - 禁止出现 `dist/src/`、`dist/scripts/` 或编译后的 spec。

不要通过修改 Docker CMD 去适配 `dist/src/*-main.js`。那会掩盖源码边界回归，并把测试和
运维脚本继续打入生产产物。

## 3. 发布前检查

### 3.1 代码和构建验证

在修复提交上执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` 会自动执行入口和目录布局门禁。仍建议人工复核：

```bash
test -f apps/api/dist/billing-main.js
test -f apps/api/dist/openapi-main.js
test ! -e apps/api/dist/src
test ! -e apps/api/dist/scripts
test -z "$(find apps/api/dist -type f -name '*.spec.*' -print -quit)"
```

四份 Dockerfile 必须从同一个修复提交、使用同一个不可变 tag 重建：

- `Dockerfile`：海外 Billing；
- `Dockerfile.openapi`：海外 OpenAPI；
- `Dockerfile.china`：国内 Billing；
- `Dockerfile.openapi.china`：国内 OpenAPI。

不得复用故障提交之前生成的构建目录或可变本地缓存来替代完整镜像构建。

| 镜像 | Dockerfile | 入口 | 端口 | 探针 |
| --- | --- | --- | --- | --- |
| 海外 Billing | `Dockerfile` | `dist/billing-main.js` | 3010 | `/api/health/live`、`/api/health/ready` |
| 国内 Billing | `Dockerfile.china` | `dist/billing-main.js` | 3010 | `/api/health/live`、`/api/health/ready` |
| 海外 OpenAPI | `Dockerfile.openapi` | `dist/openapi-main.js` | 3030 | `/health/live`、`/health/ready` |
| 国内 OpenAPI | `Dockerfile.openapi.china` | `dist/openapi-main.js` | 3030 | `/health/live`、`/health/ready` |

Dockerfile 本身没有 `HEALTHCHECK`，探针由部署平台配置。readiness 同时检查 PostgreSQL 和
Redis，任一失败都会返回 503，不能只用 liveness 代替上线验收。

### 3.2 环境检查

发布负责人需在目标环境记录并确认：

- 当前 Billing/OpenAPI 镜像 tag、Pod 数量和健康状态；
- 当前及新镜像的不可变 tag 与 digest；
- Billing consumer lag、DLQ 和 `credit_balance_outbox` 积压；
- `BILLING_CREDIT_BALANCE_OUTBOX_ENABLED=true`；不能仅因 Outbox 没有积压就推断 worker 已启用；
- 当前资金变更流量是否可以在异常时快速暂停；
- 新 tag 已推送到目标环境可访问的镜像仓库；
- 本次没有新增 migration，部署流程不得手工重跑余额回填脚本。
- 当前服务是否仍运行 Redis-first V1；若是，已安排资金写维护窗，或已证明所有 HTTP、Kafka、
  webhook、管理员操作都能按 subscription 全链路稳定路由到同一版本。

本地代码验证不能证明线上旧 Pod、migration 执行结果或 11 条 `credit_balance_state` 的状态；
这些项目必须由有环境权限的发布负责人确认。

## 4. 上线顺序

1. 保持当前仍健康的实例不动，先记录镜像、Pod 和资金状态，不要提前缩容或重启。
2. 从修复提交构建并推送全新的不可变镜像 tag。
3. 若当前实例仍是 Redis-first V1，在首个 V2 实例接收写流量前，必须暂停 quota/bonus 发放、
   重置、退款和扣减。只有已经证明全链路按 subscription 粘性隔离时才可免维护窗；普通负载
   均衡或只对 HTTP 做粘性都不满足条件。
4. 在资金写暂停期间发布 UAT Billing，确认新 Pod Ready，并等待旧 Billing V1 实例为 0。
5. 在同一维护窗发布 OpenAPI，确认新 Pod Ready，并等待旧 OpenAPI V1 实例为 0。
6. 检查 PostgreSQL 权威 state、Redis 投影、Kafka consumer、DLQ 和 Outbox 无异常后，恢复资金
   写流量。
7. 恢复后再验证一次受控充值/扣减和幂等重放；不得在 V1/V2 混跑窗口做资金写验证。
8. 观察无余额分叉、`MODULE_NOT_FOUND`、CrashLoop、consumer lag 增长或新 DLQ 后，再推广到
   下一环境。
9. 每个生产环境都重复上述维护窗或经证明的全链路粘性切换，不能做允许 V1/V2 同时写余额的
   普通滚动发布。

若现有交付流水线只自动构建/部署 Billing，而不处理 OpenAPI，必须为 OpenAPI 单独触发同一
修复提交的镜像构建与滚动，不能默认它已随 Billing 更新。

当前仓库的 GitHub Actions 只构建并发布 `Dockerfile` 对应的海外 Billing 镜像，也只自动部署
test 的 migration 与 Billing 服务；它不覆盖 OpenAPI 和两个国内镜像。开发必须在上线记录中
补充这三类镜像的实际流水线、不可变 tag/digest 和发布结果，否则不能勾选“四类镜像已完成”。

开发在 UAT/生产发布前必须填写下表；任一目标镜像缺少可执行流水线或 digest 时停止上线：

| 镜像 | 构建/发布流水线或命令 | 仓库 | 不可变 tag | digest | 目标环境 | 负责人 |
| --- | --- | --- | --- | --- | --- | --- |
| 海外 Billing | GitHub Actions `Docker Images` | `ghcr.io/raytone-lab/codesphere-billing-api` | 待填写 | 待填写 | 待填写 | 待填写 |
| 国内 Billing | 待开发填写 | 待填写 | 待填写 | 待填写 | 待填写 | 待填写 |
| 海外 OpenAPI | 待开发填写 | 待填写 | 待填写 | 待填写 | 待填写 | 待填写 |
| 国内 OpenAPI | 待开发填写 | 待填写 | 待填写 | 待填写 | 待填写 | 待填写 |

## 5. 上线后验证

- Billing 和 OpenAPI Pod 均使用同一个修复提交对应的不可变 tag。
- Billing 的 `/api/health/live`、`/api/health/ready` 均为 200；OpenAPI 的
  `/health/live`、`/health/ready` 均为 200。
- 两种容器启动命令分别加载 `dist/billing-main.js`、`dist/openapi-main.js` 成功。
- readiness/liveness 正常，重启次数不增长。
- Billing consumer lag 回落且 DLQ 没有新增异常积压。
- `credit_balance_outbox` 没有持续 `FAILED`、`RUNNING` 或 `MANUAL_REVIEW` 积压。
- 余额变更前后与 `CreditTransaction`、权威余额 state 和缓存投影一致。
- 日志中没有 `MODULE_NOT_FOUND`、`dist/src` 或加载编译后 spec/script 的记录。

## 6. 异常处理与回滚边界

本次代码没有数据库变更，镜像发布失败时优先停止继续滚动并保留尚未替换的健康实例。

资金协议已经进入 PostgreSQL 权威余额 V2 后，不得为了恢复启动而主动回滚到 Redis-first 的
旧代码，也不得删除、回滚 migration 或重做已经就位的余额 state。若新镜像无法启动：

1. 暂停后续滚动；
2. 保留仍健康的现有实例，但旧 V1 实例只能在资金写暂停或全链路隔离条件下继续服务；
3. 保持 quota/bonus 发放、重置、退款和扣减暂停；
4. 使用本修复分支继续修正并重新构建新 tag，采用向前修复；
5. 在恢复资金变更前重新检查 consumer、DLQ、Outbox 和余额一致性。

不要把故障镜像入口临时改为 `dist/src/*-main.js`，也不要通过重新执行回填脚本来解决容器
启动问题。
