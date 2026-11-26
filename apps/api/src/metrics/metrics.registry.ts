import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Central Prometheus metrics registry.
 *
 * Naming convention: `ruidong_<domain>_<name>_<unit>` following prom-client
 * best practice. `_total` suffix for counters, `_seconds` for duration.
 *
 * Cardinality discipline:
 *   - HTTP histograms use method + route-pattern + status_class, NOT raw paths
 *     (paths contain IDs and would blow up label cardinality).
 *   - Business gauges are scraped values — do NOT add user-level labels.
 */

export const registry = new Registry();

// Default Node metrics: process_resident_memory_bytes, nodejs_eventloop_lag_seconds,
// nodejs_gc_duration_seconds, process_cpu_seconds_total, etc.
// Prefix keeps our metrics distinct from other services scraped by the same Prometheus.
collectDefaultMetrics({ register: registry, prefix: 'ruidong_' });

// ============================================================
// HTTP
// ============================================================

export const httpRequestDuration = new Histogram({
  name: 'ruidong_http_request_duration_seconds',
  help: 'HTTP request latency grouped by method, route, and status class',
  // Route pattern ("/api/user/:id"), NOT the raw URL. Status class ("2xx", "5xx")
  // instead of each individual code to cap label permutations.
  labelNames: ['method', 'route', 'status_class'],
  // Buckets tuned for a NestJS API: 5ms ... 10s.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: 'ruidong_http_requests_total',
  help: 'Total HTTP requests handled by the API',
  labelNames: ['method', 'route', 'status_class'],
  registers: [registry],
});

// ============================================================
// Business: Billing & Credit
// ============================================================

export const creditDeductTotal = new Counter({
  name: 'ruidong_credit_deduct_total',
  help: 'Credit deduction attempts (money path) by outcome',
  labelNames: ['outcome'], // 'ok' | 'insufficient' | 'error' | 'compensated'
  registers: [registry],
});

// R6 v5: 自营积分负额结算——记录跨零结算的笔数与欠额（负 quota 的绝对值）。
// 用于 R6 收敛观测（GatewayBillingEvent FAILED 应随之下降）与欠额存量核对。
export const creditNegativeDeductTotal = new Counter({
  name: 'ruidong_credit_negative_deduct_total',
  help: 'Self-op credit deductions that settled across zero into negative quota',
  registers: [registry],
});

export const creditNegativeDeductDebtCredits = new Counter({
  name: 'ruidong_credit_negative_deduct_debt_credits',
  help: 'Total debt credits (abs of negative quota crossed) accrued by terminal settlement',
  registers: [registry],
});

// R6 v5: 欠额核销——负余额随旧 entitlement 废弃（换档抵扣尽/到期不续/取消）时的显式核销。
// reason 区分核销来源，便于财务口径核对（换档=debt 抵扣持有价值后仍有余；expiry/cancel=搁置出域）。
export const creditDebtWrittenOffTotal = new Counter({
  name: 'ruidong_credit_debt_written_off_total',
  help: 'Negative credit balances written off when an entitlement is abandoned',
  labelNames: ['reason'], // 'plan_switch' | 'expiry' | 'cancel'
  registers: [registry],
});

export const creditDebtWrittenOffCredits = new Counter({
  name: 'ruidong_credit_debt_written_off_credits',
  help: 'Total debt credits written off (abs of negative quota) by reason',
  labelNames: ['reason'],
  registers: [registry],
});

// R3b v5: 自营 TokenPlan 月度补发 cron——按月 resetQuota(net) 的成功/失败计数。
export const codingPlanMonthlyRefreshTotal = new Counter({
  name: 'ruidong_coding_plan_monthly_refresh_total',
  help: 'Self-op coding-plan monthly quota refreshes applied by the cron',
  registers: [registry],
});

export const codingPlanMonthlyRefreshErrors = new Counter({
  name: 'ruidong_coding_plan_monthly_refresh_errors',
  help: 'Self-op coding-plan monthly refresh failures (resetQuota threw)',
  registers: [registry],
});

// PR0-1: GRANT 池失败补偿(deduct 路径里 PG 失败 / bonus+quota 不足
// 触发的 grant 回滚)。result=ok|failed 区分 INCRBY 是否成功。
export const grantCompensateTotal = new Counter({
  name: 'ruidong_grant_compensate_total',
  help: 'GRANT pool compensation attempts (rollback after deduct failure) by result',
  labelNames: ['result'], // 'ok' | 'failed'
  registers: [registry],
});

export const creditReconcileMismatchTotal = new Counter({
  name: 'ruidong_credit_reconcile_mismatch_total',
  help: 'Credit Redis/PG reconciliation mismatches detected by balance type',
  labelNames: ['balance_type'], // 'quota_bonus' | 'grant'
  registers: [registry],
});

export const creditReconcileRunTotal = new Counter({
  name: 'ruidong_credit_reconcile_run_total',
  help: 'Credit Redis/PG reconciliation worker runs by outcome',
  labelNames: ['outcome'], // 'ok' | 'skipped' | 'error'
  registers: [registry],
});

export const creditBalanceCacheApplyTotal = new Counter({
  name: 'ruidong_credit_balance_cache_apply_total',
  help: 'Versioned credit balance cache CAS attempts by outcome',
  labelNames: ['outcome'], // applied | equal | stale | conflict | corrupt
  registers: [registry],
});

export const creditBalanceOutboxTotal = new Counter({
  name: 'ruidong_credit_balance_outbox_total',
  help: 'Credit balance cache outbox deliveries by outcome',
  labelNames: ['outcome'], // succeeded | failed | manual_review
  registers: [registry],
});

export const gatewayTenantMismatchTotal = new Counter({
  name: 'ruidong_gateway_tenant_mismatch_total',
  help: 'Gateway billing events whose tenant hint did not match the trusted billing tenant',
  labelNames: ['reason'], // bounded reason codes, never raw tenant/user/key IDs
  registers: [registry],
});

export const gatewayUsageQuarantineTotal = new Counter({
  name: 'ruidong_gateway_usage_quarantine_total',
  help: 'Gateway usage events isolated before any financial impact by bounded reason',
  labelNames: ['reason'],
  registers: [registry],
});

export const gatewayUsageEvidenceContractTotal = new Counter({
  name: 'ruidong_gateway_usage_evidence_contract_total',
  help: 'Additive Gateway provider-evidence contract observations by rollout mode and bounded issue',
  // One provider event contributes either pass/none or one observation for
  // each bounded issue found. Never label with build, request, account, or
  // provider identifiers.
  labelNames: ['mode', 'outcome', 'issue'],
  registers: [registry],
});

export const gatewayUsageReconciliationActionTotal = new Counter({
  name: 'ruidong_gateway_usage_reconciliation_action_total',
  help: 'Gateway usage reconciliation workflow actions by bounded action and outcome',
  labelNames: ['action', 'outcome'],
  registers: [registry],
});

export const gatewayCreditPolicyWindowUnavailableTotal = new Counter({
  name: 'ruidong_gateway_credit_policy_window_unavailable_total',
  help: 'Gateway occurrence windows that fail closed for enterprise credit by bounded reason',
  labelNames: ['reason'],
  registers: [registry],
});

export const enterpriseCreditPolicyRecoveryTotal = new Counter({
  name: 'ruidong_enterprise_credit_policy_recovery_total',
  help: 'Current enterprise credit policy boundary/fanout recovery attempts by bounded outcome',
  labelNames: ['outcome'], // recovered | stale | failed
  registers: [registry],
});

export const enterpriseCreditPolicyRecoveryOldestAgeSeconds = new Gauge({
  name: 'ruidong_enterprise_credit_policy_recovery_oldest_age_seconds',
  help: 'Age of the oldest current enterprise credit policy awaiting boundary or fanout recovery',
  registers: [registry],
});

// 逾期自动挂起此前是完全静默的动作：只有一行 logger.warn，没有 AlertEvent，
// 也没有任何外发通知。2026-08-28 一个企业账户因此被挂起后 43 秒落了一笔消费，
// 3 秒后 debt_open 关闸，静默断服 6h32m，直到当天恰好有一笔充值才解封。
// 下面五个指标就是那次事故缺的探针。
//
// 刻意不带 billing_account_id 标签：与既有 enterpriseCreditPolicyRecoveryOldestAgeSeconds
// 保持同一约定（聚合口径 + 低基数），账户身份走结构化日志和 alert_events。
// 告警的阈值判定与去重交给 Alertmanager（它本来就有 repeat_interval 和分组），
// 应用侧不再自建 7/3/1 天的一次性去重表。
export const enterpriseCreditEnforcementEarliestSeconds = new Gauge({
  name: 'ruidong_enterprise_credit_enforcement_earliest_seconds',
  help: 'Seconds until the earliest enterprise credit service-suspension moment; negative once already enforceable',
  registers: [registry],
});

export const enterpriseCreditOverdueAccounts = new Gauge({
  name: 'ruidong_enterprise_credit_overdue_accounts',
  help: 'Enterprise credit accounts by proximity to automatic service suspension',
  labelNames: ['phase'], // due_7d | due_3d | due_1d | enforceable
  registers: [registry],
});

export const ENTERPRISE_CREDIT_OVERDUE_PHASES = [
  'due_7d',
  'due_3d',
  'due_1d',
  'enforceable',
] as const;

export const enterpriseCreditOverdueSuspendTotal = new Counter({
  name: 'ruidong_enterprise_credit_overdue_suspend_total',
  help: 'Automatic enterprise credit suspension decisions by bounded outcome',
  labelNames: ['outcome'], // suspended | deferred_by_grace
  registers: [registry],
});

// 这两个是「客户实际断服」的直接口径，与授信是否逾期无关：
// 任何原因建立的 account 级 debt_open 都会计入（无配置 / SUSPENDED / DISABLED /
// 零额度 / 过期额度 / 额度耗尽都会走到那条路，逾期挂起只是其中一个入口）。
export const billingDebtOpenRestrictionsActive = new Gauge({
  name: 'ruidong_billing_debt_open_restrictions_active',
  help: 'ACTIVE debt_open billing access restrictions (customers currently gated by unrepaid debt)',
  registers: [registry],
});

export const billingDebtOpenOldestAgeSeconds = new Gauge({
  name: 'ruidong_billing_debt_open_oldest_age_seconds',
  help: 'Age of the oldest ACTIVE debt_open restriction — the customer-visible outage clock',
  registers: [registry],
});

export const billingUsageKafkaMessagesTotal = new Counter({
  name: 'ruidong_billing_usage_kafka_messages_total',
  help: 'Billing UsageEvent Kafka transport outcomes with a fixed low-cardinality outcome set',
  // committed | poison_dlq | transient_uncommitted | dlq_send_failed
  // | provisional_exposure_invariant_dlq | provisional_exposure_invariant_dlq_failed
  // | provisional_exposure_blocked
  labelNames: ['outcome'],
  registers: [registry],
});

/**
 * provisional exposure writer 的判定结果。
 *
 * ⚠️ 本仓 /metrics 目前**没有任何环境在抓取**，所以这个 counter 不构成可运营信号 ——
 * 真正能用的是结构化日志 `gateway_provisional_exposure_outcome`。保留 counter 是为了
 * 一旦有采集栈可直接接上，且十一个标签在启动时**全部预注册**，
 * 消除「序列首次出现之前那一次增量看不到」的空窗。
 */
export const billingProvisionalExposureOutcomeTotal = new Counter({
  name: 'ruidong_billing_provisional_exposure_outcome_total',
  help: 'Provisional exposure writer outcomes with a fixed low-cardinality outcome set',
  labelNames: ['outcome'],
  registers: [registry],
});

/**
 * writer 的 outcome 全集（低基数、用于零值预热）。
 *
 * ⚠️ 这里是 outcome 的**唯一真源**：service 的 ProvisionalExposureOutcome 已改为
 * `typeof PROVISIONAL_EXPOSURE_OUTCOMES[number]`，所以往这个数组里加/删一项，writer 那侧
 * 编译期就会跟着红。
 *
 * 但派生只保证**单向**：writer 里删掉某个 `return '...'` 不会报错，只会在看板上留一条永远 0 的
 * 死 series。曾经反过来漏改一次（`disabled` 改成 `schema_not_ready` 时这里没跟上，全套测试照旧
 * 全绿），因此这条注释保留作提醒。
 */
export const PROVISIONAL_EXPOSURE_OUTCOMES = [
  'inserted',
  'idempotent_consistent',
  'pre_cutover',
  'zero_output',
  'forced_skip',
  'legacy_original_evidence_missing',
  'stream_true',
  'stream_field_absent_or_invalid',
  'unsupported_status',
  // 正输出但不是安全整数（畸形/恶意载荷）⇒ 不写、不抛。旁路观测不得改主路径终态。
  'output_tokens_unrepresentable',
  'invariant_error',
  // 旁路写入本身失败被归为不变量后的标签。与 invariant_error 分开：前者是记录内容矛盾，
  // 后者是基础设施/权限/schema 问题，运维动作完全不同（查库权限 vs 查这条消息）。
  'persistence_failed',
  'schema_not_ready',
] as const;

for (const outcome of PROVISIONAL_EXPOSURE_OUTCOMES) {
  billingProvisionalExposureOutcomeTotal.labels(outcome).inc(0);
}

/**
 * provisional exposure 的历史边界（unix 秒），0 = schema 未就绪。
 *
 * 已经**没有** enabled 开关了：边界来自「建 exposure 表那次迁移的完成时刻」，
 * 不再有一次性翻转的环境变量。这个 gauge 只用于确认各副本读到的是**同一个**边界
 * （有采集栈时对 max-min != 0 告警即可）。
 */
export const billingProvisionalExposureBoundarySeconds = new Gauge({
  name: 'ruidong_billing_provisional_exposure_boundary_seconds',
  help: 'Provisional exposure history boundary as unix seconds; 0 when schema is not ready',
  registers: [registry],
});

export const billingUsageKafkaHmacVerificationsTotal = new Counter({
  name: 'ruidong_billing_usage_kafka_hmac_verifications_total',
  help: 'Billing UsageEvent Kafka HMAC v1 outcomes without key-id labels',
  // mode: off | shadow | required; outcome is the bounded verifier result.
  labelNames: ['mode', 'outcome'],
  registers: [registry],
});

export const billingRestrictionProjectionTotal = new Counter({
  name: 'ruidong_billing_restriction_projection_total',
  help: 'Durable Billing restriction projection attempts by bounded outcome',
  // succeeded | noop | deferred | failed | skipped | scan_failed
  // | metrics_query_failed
  labelNames: ['outcome'],
  registers: [registry],
});

export const billingRestrictionProjectionBacklog = new Gauge({
  name: 'ruidong_billing_restriction_projection_backlog',
  help: 'Current non-succeeded Billing restriction projection intents from the database',
  registers: [registry],
});

export const billingRestrictionProjectionOldestAgeSeconds = new Gauge({
  name: 'ruidong_billing_restriction_projection_oldest_age_seconds',
  help: 'Age of the oldest non-succeeded Billing restriction projection intent from the database',
  registers: [registry],
});

export const publisherRetryWorkerTotal = new Counter({
  name: 'ruidong_publisher_retry_worker_total',
  help: 'Publisher retry worker job outcomes with a fixed low-cardinality outcome set',
  // succeeded | retryable_failed | publisher_unavailable | exhausted |
  // permanent_failed | retired | skipped | scan_failed | metrics_query_failed
  labelNames: ['outcome'],
  registers: [registry],
});

export const publisherQueueJanitorTotal = new Counter({
  name: 'ruidong_publisher_queue_janitor_total',
  help: 'Publisher queue retention sweeps by bounded outcome',
  // swept | failed
  labelNames: ['outcome'],
  registers: [registry],
});

export const publisherQueueJanitorDeletedTotal = new Counter({
  name: 'ruidong_publisher_queue_janitor_deleted_total',
  help: 'Rows removed by the Publisher queue retention janitor',
  labelNames: ['table'],
  registers: [registry],
});

export const publisherQueueJanitorBacklog = new Gauge({
  name: 'ruidong_publisher_queue_janitor_backlog',
  help: 'Terminal Publisher queue rows already older than their retention window',
  labelNames: ['table'],
  registers: [registry],
});

export const publisherSettlementKeyBalanceSyncTotal = new Counter({
  name: 'ruidong_publisher_settlement_key_balance_sync_total',
  help: 'Post-settlement single-Key balance publish decisions on the non-exhausted path',
  // published | skipped_unchanged
  labelNames: ['outcome'],
  registers: [registry],
});

export const publisherRetryBacklog = new Gauge({
  name: 'ruidong_publisher_retry_backlog',
  help: 'Current retryable Publisher sync job backlog from the database',
  registers: [registry],
});

export const publisherRetryBacklogOldestAgeSeconds = new Gauge({
  name: 'ruidong_publisher_retry_backlog_oldest_age_seconds',
  help: 'Age of the oldest retryable Publisher sync job from the database',
  registers: [registry],
});

// ============================================================
// Business: Payment & Orders
// ============================================================

export const paymentCallbackTotal = new Counter({
  name: 'ruidong_payment_callback_total',
  help: 'Payment provider callbacks received, by channel and outcome',
  labelNames: ['channel', 'outcome'], // channel: wechat|alipay|stripe, outcome: ok|bad_sig|replay|handler_error
  registers: [registry],
});

export const ordersPending = new Gauge({
  name: 'ruidong_orders_pending',
  help: 'Orders stuck in PENDING longer than 5 minutes (set by a periodic job)',
  registers: [registry],
});

// ============================================================
// Business: Integration (outbound webhooks)
// ============================================================

export const webhookQueueDepth = new Gauge({
  name: 'ruidong_webhook_queue_depth',
  help: 'BullMQ depth for outbound integration webhook queue',
  labelNames: ['state'], // 'waiting' | 'active' | 'delayed' | 'failed'
  registers: [registry],
});

// ============================================================
// Infrastructure: DB & Redis
// ============================================================

export const dbConnectionPool = new Gauge({
  name: 'ruidong_db_connection_pool',
  help: 'Prisma connection pool usage (sampled from internal metrics)',
  labelNames: ['state'], // 'active' | 'idle' | 'waiting'
  registers: [registry],
});

export const redisCommandErrors = new Counter({
  name: 'ruidong_redis_command_errors_total',
  help: 'Redis command failures surfaced from ioredis',
  labelNames: ['command'],
  registers: [registry],
});

/**
 * Growth of the per-event history tables whose size drives per-event settlement
 * cost. Labelled by table only: account identifiers are unbounded and belong in
 * the log line, not in a series label.
 */
export const billingHistoryTableRows = new Gauge({
  name: 'ruidong_billing_history_table_rows',
  help: 'Total rows in a per-event billing history table with no cold/hot separation',
  labelNames: ['table'],
  registers: [registry],
});

/**
 * Rows held by the single worst account in that table. This, not the total, is
 * what the settlement path pays per event — cost is proportional to one
 * account's own history, so a large total spread thinly is harmless while a
 * concentrated one is not.
 */
export const billingHistoryHotAccountRows = new Gauge({
  name: 'ruidong_billing_history_hot_account_rows',
  help: 'Rows held by the largest single billing account in that history table',
  labelNames: ['table'],
  registers: [registry],
});

/**
 * Unsettled debt allocations for the worst account. The row-by-row deferred
 * conservation trigger at COMMIT is not removable by batching, so this number
 * is the ceiling on how large a settlement can get before it exceeds the
 * transaction budget again.
 */
export const billingUnsettledDebtRows = new Gauge({
  name: 'ruidong_billing_unsettled_debt_rows',
  help: 'Unsettled debt allocation rows held by the largest single billing account',
  labelNames: ['source'],
  registers: [registry],
});

/** Cost of the growth sample itself, so it cannot quietly become the problem. */
export const billingHistoryGrowthWatchDurationMs = new Gauge({
  name: 'ruidong_billing_history_growth_watch_duration_ms',
  help: 'Duration of the last history growth sampling pass',
  registers: [registry],
});

/**
 * Balance grants past expires_at that the expiry sweep has not marked.
 *
 * `scope="all"` is flag hygiene; `scope="with_balance"` is the one that matters —
 * the expiry sweep also debits the wallet for grant balance that expires unspent,
 * and that worker is disabled in every environment except HK UAT. While
 * with_balance stays 0 the disabled sweep owes nothing; above 0 it does.
 */
export const billingOverdueUnmarkedGrants = new Gauge({
  name: 'ruidong_billing_overdue_unmarked_grants',
  help: 'Balance grants past expires_at with is_expired still false',
  labelNames: ['scope'],
  registers: [registry],
});

export const billingWorkerGateBacklog = new Gauge({
  name: 'ruidong_billing_worker_gate_backlog',
  help: 'Non-terminal work waiting behind a billing worker gate',
  labelNames: ['worker', 'status'],
  registers: [registry],
});

export const billingWorkerGateOldestAgeSeconds = new Gauge({
  name: 'ruidong_billing_worker_gate_oldest_age_seconds',
  help: 'Age in seconds of the oldest non-terminal item behind a billing worker gate',
  labelNames: ['worker'],
  registers: [registry],
});

/**
 * Current platform-currency balance for active enterprise accounts on the
 * prepaid path (no credit config, or credit explicitly disabled/suspended).
 *
 * Account identity is required for an actionable commercial alert. The query
 * is deliberately limited to active prepaid enterprise accounts, rather than
 * every user or tenant, to keep the label set bounded.
 */
export const enterprisePrepaidBalanceAmount = new Gauge({
  name: 'ruidong_billing_enterprise_prepaid_balance_amount',
  help: 'Current balance of an active prepaid enterprise account in platform currency units',
  labelNames: ['billing_account_id', 'account_name', 'currency'],
  registers: [registry],
});

export const enterprisePrepaidConsumption7dAmount = new Gauge({
  name: 'ruidong_billing_enterprise_prepaid_consumption_7d_amount',
  help: 'Balance consumed by an active prepaid enterprise account during the last 7 days',
  labelNames: ['billing_account_id', 'account_name', 'currency'],
  registers: [registry],
});

/**
 * Per-series freshness is necessary because the fleet-wide sampler lock can
 * move between pods. Old process-local gauges remain exposed until that pod is
 * replaced, so PromQL must discard a balance whose matching timestamp is old.
 */
export const enterprisePrepaidBalanceSampleTimestampSeconds = new Gauge({
  name: 'ruidong_billing_enterprise_prepaid_balance_sample_timestamp_seconds',
  help: 'Unix timestamp of the sample backing an enterprise prepaid balance series',
  labelNames: ['billing_account_id', 'account_name', 'currency'],
  registers: [registry],
});

export const enterprisePrepaidBalanceWatchSuccessTimestampSeconds = new Gauge({
  name: 'ruidong_billing_enterprise_prepaid_balance_watch_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful enterprise prepaid balance sampling pass',
  registers: [registry],
});

/**
 * FIFO 队头判定（`resolveGatewayFundingBlocker`）的结果分布。
 *
 * 为什么用 counter 而不是继续读 stage-timing 日志（四条,都不是「日志有采样」）:
 *
 * 1. **日志按尝试次数计数,不是按 request/account**。Kafka 重试会把同一条消息
 *    重复计入,而 stage timing 行里没有 requestId/accountId,无法去重或按账户切分。
 *    counter 是聚合语义,配合 rate()/increase() 才能得到可比的比率。
 * 2. **只有 counter 能配告警规则**。日志得靠人去 grep,而这个比率恰恰是
 *    「能不能切 guard」的放行判据,需要持续盯而不是某次抽查。
 * 3. **不依赖日志保留期**。Loki 只留 15 天,而这个判据要等真实的队头阻塞出现,
 *    可能需要更长的观察窗口。
 * 4. **不依赖 BILLING_USAGE_STAGE_TIMING_MIN_MS 保持为 0**。该值代码默认 250ms
 *    (billing-usage-kafka-consumer.service.ts:431),判定是 `totalMs >= 阈值`。
 *    四个环境目前都显式设成 0(= 全量记录),所以日志当前**没有**阈值偏置;
 *    但把观测的无偏性寄托在一个 env 值上是脆弱的 —— 有人改回默认,
 *    快速返回的消息就会开始被过滤,而命中 blocker 时 LIMIT 1 恰好返回得快。
 *
 * ⚠️ 2026-09-03 的教训不是「日志有偏置」,而是**空集一致不能当等价性证据**:
 * 当时从国内 prod 数出 `resvBlockingMiss=4450 / Hit=0 / agree=4450`,
 * 据此准备把 BILLING_FUNDING_BLOCKER_SOURCE 切到 guard。那 4450 次 agree
 * 全是 `null === null` —— 两条查询都返回空,当然相等;而只读 SQL 也确认
 * 该库当时符合 anchors 阻塞条件的行数为 0。**真正要验的「有阻塞时两者是否
 * 指向同一条」一次都没执行过。**（我一度把原因归为 250ms 阈值偏置,
 * 那是查了配置才发现的错误归因:四个环境都是 0。）
 *
 * 放行判据因此是:outcome=hit **有量**,且 source=compare 的 diverge 与 error
 * 都恒为 0。error 必须一起看 —— 比对失败会被 catch 静默吞掉(见 billing.service)。
 *
 * (此前只有日志一条路,是因为 /metrics 在任何环境都没有被抓取;
 *  2026-09-03 已为两地 prod 的 billing-api 装上 ServiceMonitor,该限制已解除。)
 */
export const billingFundingBlockerTotal = new Counter({
  name: 'ruidong_billing_funding_blocker_total',
  help: 'FIFO head-of-line blocker lookups by query source and outcome',
  // source: 'anchor'(旧全量扫) | 'guard'(guard 集合入口) | 'compare'(双读比对本身)
  // outcome: 'hit'(找到阻塞) | 'miss'(无阻塞) | 'agree' | 'diverge' | 'error'
  labelNames: ['source', 'outcome'],
  registers: [registry],
});
