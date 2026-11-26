import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BillingService } from '../billing/billing.service';
import {
  enqueueEnterpriseCreditPolicyFanout,
  enqueueEnterpriseCreditTimedFanout,
  type EnterpriseCreditTimedFanoutPhase,
} from '../billing/enterprise-credit-policy-fanout';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ENTERPRISE_CREDIT_OVERDUE_PHASES,
  billingDebtOpenOldestAgeSeconds,
  billingDebtOpenRestrictionsActive,
  enterpriseCreditEnforcementEarliestSeconds,
  enterpriseCreditOverdueAccounts,
  enterpriseCreditOverdueSuspendTotal,
  enterpriseCreditPolicyRecoveryOldestAgeSeconds,
  enterpriseCreditPolicyRecoveryTotal,
} from '../metrics/metrics.registry';

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const ENTERPRISE_ACCOUNT_TYPE = 'enterprise';
const CREDIT_STATUS_ACTIVE = 'ACTIVE';
const CREDIT_STATUS_SUSPENDED = 'SUSPENDED';
const OVERDUE_REASON = 'overdue_auto_suspend';
const OVERDUE_ACTOR = 'system:credit-overdue';
const CANDIDATE_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/**
 * 本 worker 所有触碰钱包行锁(lockCreditAggregate 第一行就 FOR UPDATE account_wallets)
 * 的事务,超时必须与 BillingService 的核销预算(BALANCE_LEDGER_TRANSACTION_OPTIONS.timeout
 * =60s)同量级:大账户欠款核销一个窗口实测 32.9s,期间钱包锁被持有;若这里仍是 Prisma
 * 默认的 5s,排队等锁就能把事务等死 —— 2026-09-21 国内 prod 充值被连带回滚的直接帮凶。
 */
const WORKER_FINANCIAL_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;
/** 无待挂起账户时的哨兵值：一年。见 observeOverdueHorizon 的说明。 */
const NO_ENFORCEMENT_PENDING_SECONDS = 365 * 24 * 60 * 60;

/**
 * 观测用的「临近挂起」分档。判定在 Alertmanager，这里只负责把账户数落到桶里，
 * 所以档位必须从宽到严排列，取第一个命中的档。
 */
const OVERDUE_PHASE_THRESHOLDS: Array<{
  phase: (typeof ENTERPRISE_CREDIT_OVERDUE_PHASES)[number];
  withinMs: number;
}> = [
  { phase: 'enforceable', withinMs: 0 },
  { phase: 'due_1d', withinMs: 1 * DAY_MS },
  { phase: 'due_3d', withinMs: 3 * DAY_MS },
  { phase: 'due_7d', withinMs: 7 * DAY_MS },
];

export interface EnterpriseCreditOverdueSweepResult {
  trigger: string;
  skipped: boolean;
  scanned: number;
  suspended: number;
  residualSettledAccounts: number;
  policyRestoredReleases: number;
  failed: number;
}

/**
 * 企业信用账期 worker（termsDays 生效点）。每次 sweep 做两件事：
 *
 * 1. 逾期自动暂停：credit config ACTIVE 且设置了 termsDays 的企业账户，
 *    钱包为负（有真实欠款）且未核销 ENTERPRISE_CREDIT 消费超过其发生时冻结
 *    的账期（存量行才回落到当前 termsDays）→ 把 config 置为 SUSPENDED（有效额度归零、新消费停止，
 *    还款/充值不受影响），写 credit event（reason=overdue_auto_suspend）留审计，
 *    并触发 key-balance fanout 让网关尽快感知。
 * 2. 残留核销兜底：钱包欠款已回正但分摊仍挂账（未接入核销的注资路径/存量数据）
 *    的账户，调 BillingService.sweepEnterpriseCreditResidualSettlement 补核销，
 *    防止「已还清却被误判逾期」。
 *
 * 兜底先行、逾期判定在后：同一轮先补核销再判逾期，避免误停。
 */
@Injectable()
export class EnterpriseCreditOverdueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnterpriseCreditOverdueWorkerService.name);
  private readonly lockKey = 'billing:enterprise-credit-overdue:lock';
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly publisherSync: PublisherSyncService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip enterprise credit overdue worker outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('Enterprise credit overdue worker disabled');
      return;
    }
    const intervalMs = this.intervalMs();
    this.interval = setInterval(() => {
      void this.runOnce('interval');
    }, intervalMs);
    this.interval.unref?.();
    this.startupTimer = setTimeout(() => {
      void this.runOnce('startup');
    }, this.startupDelayMs());
    this.startupTimer.unref?.();
    this.logger.log(`scheduled enterprise credit overdue worker intervalMs=${intervalMs}`);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async runOnce(trigger = 'manual'): Promise<EnterpriseCreditOverdueSweepResult> {
    const result: EnterpriseCreditOverdueSweepResult = {
      trigger,
      skipped: false,
      scanned: 0,
      suspended: 0,
      residualSettledAccounts: 0,
      policyRestoredReleases: 0,
      failed: 0,
    };
    if (this.running) {
      result.skipped = true;
      return result;
    }
    const lockToken = randomUUID();
    const locked = await this.acquireLock(lockToken);
    if (!locked) {
      result.skipped = true;
      return result;
    }
    this.running = true;
    try {
      // 1) 残留核销兜底（先行，避免已还清账户被误判逾期）。
      const staleAccounts = await this.prisma.balanceConsumptionAllocation.findMany({
        where: { source: 'ENTERPRISE_CREDIT', settledAt: null, billingAccountId: { not: null } },
        distinct: ['billingAccountId'],
        select: { billingAccountId: true },
        take: CANDIDATE_BATCH,
      });
      for (const row of staleAccounts) {
        if (!row.billingAccountId) continue;
        try {
          const settledCents = await this.billing.sweepEnterpriseCreditResidualSettlement(
            row.billingAccountId,
          );
          if (settledCents > 0) {
            result.residualSettledAccounts += 1;
            this.logger.log(
              `enterprise credit residual settled account=${row.billingAccountId} cents=${settledCents}`,
            );
          }
        } catch (err) {
          result.failed += 1;
          this.logger.error(
            `enterprise credit residual settle failed account=${row.billingAccountId}: ${(err as Error).message}`,
          );
        }
      }

      // 2) Recover every current policy revision (admin, overdue, bootstrap)
      // whose config/event transaction committed before boundary confirmation
      // or durable Publisher fanout. The join is essential: stale revisions
      // must never be projected back over the current config and must not fill
      // the bounded recovery batch forever.
      const recoveries = await this.prisma.$queryRaw<Array<{
        id: string;
        billingAccountId: string;
        policyRevision: number;
        createdAt: Date;
      }>>`
        SELECT
          event."id",
          event."billing_account_id" AS "billingAccountId",
          event."policy_revision" AS "policyRevision",
          event."created_at" AS "createdAt"
        FROM "billing_account_credit_events" event
        INNER JOIN "billing_account_credit_configs" config
          ON config."billing_account_id" = event."billing_account_id"
         AND config."policy_revision" = event."policy_revision"
        WHERE event."policy_revision" IS NOT NULL
          AND (
            NOT event."policy_boundary_complete"
            OR event."policy_fanout_enqueued_at" IS NULL
          )
        ORDER BY event."created_at" ASC, event."id" ASC
        LIMIT ${CANDIDATE_BATCH}
      `;
      const oldestRecoveryAt = recoveries[0]?.createdAt;
      enterpriseCreditPolicyRecoveryOldestAgeSeconds.set(
        oldestRecoveryAt instanceof Date && !Number.isNaN(oldestRecoveryAt.getTime())
          ? Math.max(0, (Date.now() - oldestRecoveryAt.getTime()) / 1000)
          : 0,
      );
      for (const recovery of recoveries) {
        try {
          const stillCurrent = await this.confirmPolicyBoundary(
            recovery.billingAccountId,
            recovery.id,
            recovery.policyRevision,
          );
          if (!stillCurrent) {
            enterpriseCreditPolicyRecoveryTotal.inc({ outcome: 'stale' });
            continue;
          }
          await enqueueEnterpriseCreditPolicyFanout(this.prisma, this.publisherSync, {
            billingAccountId: recovery.billingAccountId,
            eventId: recovery.id,
            policyRevision: recovery.policyRevision,
          });
          enterpriseCreditPolicyRecoveryTotal.inc({ outcome: 'recovered' });
        } catch (err) {
          enterpriseCreditPolicyRecoveryTotal.inc({ outcome: 'failed' });
          result.failed += 1;
          this.logger.error(
            `enterprise credit policy recovery failed event=${recovery.id}: ${(err as Error).message}`,
          );
        }
      }

      // 3) Project wall-clock credit boundaries. Immediate policy fanout is
      // insufficient for a future effectiveAt/expiresAt; each due phase remains
      // unmarked until Publisher accepted or durably queued every Key refresh.
      const timedFanoutsRaw = await this.prisma.$queryRaw<Array<{
        id: string;
        billingAccountId: string;
        policyRevision: number;
        phase: EnterpriseCreditTimedFanoutPhase;
      }>>`
        SELECT * FROM (
          SELECT
            event."id",
            event."billing_account_id" AS "billingAccountId",
            event."policy_revision" AS "policyRevision",
            'ACTIVATION'::TEXT AS "phase"
          FROM "billing_account_credit_events" event
          INNER JOIN "billing_account_credit_configs" config
            ON config."billing_account_id" = event."billing_account_id"
           AND config."policy_revision" = event."policy_revision"
          WHERE event."policy_boundary_complete"
            AND event."activation_fanout_enqueued_at" IS NULL
            AND config."status" = ${CREDIT_STATUS_ACTIVE}
            AND config."limit_usd" > 0
            AND config."terms_days" > 0
            AND config."effective_at" IS NOT NULL
            AND config."effective_at" <= clock_timestamp()

          UNION ALL

          SELECT
            event."id",
            event."billing_account_id" AS "billingAccountId",
            event."policy_revision" AS "policyRevision",
            'EXPIRATION'::TEXT AS "phase"
          FROM "billing_account_credit_events" event
          INNER JOIN "billing_account_credit_configs" config
            ON config."billing_account_id" = event."billing_account_id"
           AND config."policy_revision" = event."policy_revision"
          WHERE event."policy_boundary_complete"
            AND event."expiration_fanout_enqueued_at" IS NULL
            AND config."expires_at" IS NOT NULL
            AND config."expires_at" <= clock_timestamp()
        ) due
        ORDER BY due."billingAccountId", due."policyRevision", due."phase"
        LIMIT ${CANDIDATE_BATCH}
      `;
      const timedFanouts = timedFanoutsRaw.filter(
        (candidate) => candidate.phase === 'ACTIVATION' || candidate.phase === 'EXPIRATION',
      );
      for (const candidate of timedFanouts) {
        try {
          await enqueueEnterpriseCreditTimedFanout(this.prisma, this.publisherSync, {
            billingAccountId: candidate.billingAccountId,
            eventId: candidate.id,
            policyRevision: candidate.policyRevision,
            phase: candidate.phase,
          });
        } catch (err) {
          result.failed += 1;
          this.logger.error(
            `enterprise credit ${candidate.phase.toLowerCase()} fanout failed `
            + `event=${candidate.id}: ${(err as Error).message}`,
          );
        }
      }

      // 4) 逾期自动暂停。外层查询只负责缩小候选集；所有资金/账期事实
      // 都会在 wallet -> account -> config 锁后重新读取和判断。
      const now = new Date();
      const candidates = await this.prisma.billingAccountCreditConfig.findMany({
        where: {
          status: CREDIT_STATUS_ACTIVE,
          billingAccount: {
            type: ENTERPRISE_ACCOUNT_TYPE,
            deletedAt: null,
            wallet: { balanceUsd: { lt: 0 } },
            balanceConsumptionAllocations: {
              some: {
                source: 'ENTERPRISE_CREDIT',
                settledAt: null,
                OR: [
                  {
                    creditPolicySnapshotComplete: true,
                    creditDueAt: { not: null, lte: now },
                  },
                  { creditPolicySnapshotComplete: false },
                ],
              },
            },
          },
        },
        select: { billingAccountId: true },
        take: CANDIDATE_BATCH,
      });
      // 授信恢复解限的候选：当前正被 debt_open 关闸的账户。
      // 直接查关闸表而不是从 config 侧连接 —— BillingAccessRestriction.billingAccountId
      // 只是标量列，schema 里没有到 BillingAccount 的关系。
      // 走 (billing_account_id, status) 索引；这个集合本来就极小
      // （全库 ACTIVE 的 debt_open 2026-09-01 实测 4 条），不做二次过滤，
      // 授信状态/额度/敞口全部由解封方法自己重读判定。
      const restoreCandidateRows = await this.prisma.billingAccessRestriction.findMany({
        where: {
          status: 'ACTIVE',
          reason: 'debt_open',
          billingAccountId: { not: null },
        },
        distinct: ['billingAccountId'],
        select: { billingAccountId: true },
        take: CANDIDATE_BATCH,
      });
      const restoreCandidates = restoreCandidateRows.flatMap((row) => (
        row.billingAccountId ? [{ billingAccountId: row.billingAccountId }] : []
      ));
      result.scanned = recoveries.length + timedFanouts.length + candidates.length;
      for (const candidate of candidates) {
        try {
          const suspended = await this.suspendIfOverdue(candidate);
          if (suspended) result.suspended += 1;
        } catch (err) {
          result.failed += 1;
          this.logger.error(
            `enterprise credit overdue check failed account=${candidate.billingAccountId}: ${(err as Error).message}`,
          );
        }
      }
      // 4.5) 授信恢复解限兜底。管理端改回 ACTIVE 时已经同步调过一次，
      // 但那条是 best-effort（进程崩溃/解封事务失败都会漏），所以这里每轮重试。
      // 放在逾期判定之后：本轮该挂的已经挂了，避免刚挂起又被自己解封。
      // 方法幂等且判据全部重读，重复调用无副作用。
      for (const candidate of restoreCandidates) {
        try {
          const released = await this.prisma.$transaction(
            (tx) => (
              this.billing.releasePolicyRestoredGatewayBalanceDebtRestrictions(
                tx,
                candidate.billingAccountId,
              )
            ),
            WORKER_FINANCIAL_TRANSACTION_OPTIONS,
          );
          if (released > 0) {
            result.policyRestoredReleases += released;
            this.logger.log(
              'enterprise credit policy restored release (worker fallback) '
              + `account=${candidate.billingAccountId} released=${released}`,
            );
          }
        } catch (err) {
          result.failed += 1;
          this.logger.error(
            'enterprise credit policy restored release failed '
            + `account=${candidate.billingAccountId}: ${(err as Error).message}`,
          );
        }
      }

      // 5) 观测。放在挂起之后，让指标反映本轮动作后的状态。
      // 纯观测失败不计入 result.failed —— 那个计数是给「真动作失败」告警用的，
      // 掺进探针故障会让告警失去意义。
      await this.observeOverdueHorizon();
      await this.observeDebtOpenRestrictions();

      if (result.suspended > 0 || result.residualSettledAccounts > 0 || result.failed > 0) {
        this.logger.log(
          `enterprise credit overdue sweep done trigger=${trigger} scanned=${result.scanned} ` +
            `suspended=${result.suspended} residual=${result.residualSettledAccounts} failed=${result.failed}`,
        );
      }
      return result;
    } catch (error) {
      // DB 闪断等瞬时错误不得打崩 billing（void runOnce 未捕获拒绝会退出进程）。
      result.failed += 1;
      result.skipped = false;
      this.logger.error(
        `enterprise credit overdue sweep failed trigger=${trigger}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return result;
    } finally {
      this.running = false;
      await this.releaseLock(lockToken);
    }
  }

  private async suspendIfOverdue(
    candidate: { billingAccountId: string },
  ): Promise<boolean> {
    const mutation = await this.prisma.$transaction(async (tx) => {
      // Match all other financial mutations: wallet -> account -> credit
      // config. This serializes automatic suspension with admin changes and
      // delayed settlements without introducing a reverse lock order.
      const locked = await this.lockCreditAggregate(tx, candidate.billingAccountId);
      if (locked.walletBalanceUsd.gte(0)) return false;
      const config = await tx.billingAccountCreditConfig.findUnique({
        where: { billingAccountId: candidate.billingAccountId },
      });
      if (!config || config.status !== CREDIT_STATUS_ACTIVE) return false;
      await this.confirmPreviousBoundaryUnderLock(
        tx,
        candidate.billingAccountId,
        config.policyRevision,
      );
      const [frozenOldest, legacyOldest] = await Promise.all([
        tx.balanceConsumptionAllocation.findFirst({
          where: {
            billingAccountId: candidate.billingAccountId,
            source: 'ENTERPRISE_CREDIT',
            settledAt: null,
            creditPolicySnapshotComplete: true,
            creditDueAt: { not: null },
          },
          orderBy: [{ creditDueAt: 'asc' }, { ledgerSequence: 'asc' }, { id: 'asc' }],
          select: { createdAt: true, creditTermsDays: true, creditDueAt: true },
        }),
        tx.balanceConsumptionAllocation.findFirst({
          where: {
            billingAccountId: candidate.billingAccountId,
            source: 'ENTERPRISE_CREDIT',
            settledAt: null,
            creditPolicySnapshotComplete: false,
          },
          orderBy: [{ createdAt: 'asc' }, { ledgerSequence: 'asc' }, { id: 'asc' }],
          select: { createdAt: true, creditTermsDays: true, creditDueAt: true },
        }),
      ]);
      const frozenDueAt = frozenOldest?.creditDueAt ?? null;
      const legacyDueAt = legacyOldest && config.termsDays && config.termsDays > 0
        ? new Date(legacyOldest.createdAt.getTime() + config.termsDays * DAY_MS)
        : null;
      const dueAt = !frozenDueAt
        ? legacyDueAt
        : !legacyDueAt || frozenDueAt.getTime() <= legacyDueAt.getTime()
          ? frozenDueAt
          : legacyDueAt;
      if (!dueAt) return false;
      const lockedNow = await this.capturePolicyClock(tx);
      // 宽限期只推迟「服务挂起」，不改变「合同到期日」：dueAt 仍是发生时冻结账期
      // 算出的到期日，enforceAt 才是真正会断服的时刻。两者必须分别落审计和日志，
      // 否则客户/销售看到的日期会互相矛盾。
      const graceMs = this.overdueGraceHours() * HOUR_MS;
      const enforceAt = new Date(dueAt.getTime() + graceMs);
      if (enforceAt.getTime() > lockedNow.getTime()) {
        // 已过到期日、但仍在宽限期内 —— 这是催收窗口，值得计数；
        // 完全没到期的账户是常态，不计数。
        return dueAt.getTime() <= lockedNow.getTime() ? 'deferred' : false;
      }
      // 人工恢复授信后的催收豁免（业务定 7 天，亚明总 2026-09-02）。
      // 刻意不加列：「当前 revision 是不是人工恢复的、什么时候恢复的」可以从
      // 既有不可变审计读出来，省掉一次跨环境 migration 编号对齐。
      // credit event 有 @@unique([billingAccountId, policyRevision])（schema.prisma:253），
      // 所以当前 revision 只对应唯一一条，取值确定、无歧义。
      //
      // ⚠️ 已知且被接受的代价：运营每次在后台碰一下授信配置都会 bump policyRevision、
      // 写一条新 event，于是豁免窗口重新计时。业务明确选择不限次数（问题 4），
      // 所以逾期风控可以被每 7 天续一次、无限期绕过，唯一护栏是每次都留下
      // 带 actor_id 的审计行。要收紧就在这里加「总计不超过 N 小时」或「最多 N 次」。
      const restoreDeferredUntil = await this.restoreDeferredUntil(tx, config);
      if (restoreDeferredUntil && restoreDeferredUntil.getTime() > lockedNow.getTime()) {
        return 'deferred';
      }
      const oldest = frozenDueAt && dueAt.getTime() === frozenDueAt.getTime()
        ? frozenOldest!
        : legacyOldest!;
      const appliedTermsDays = oldest.creditTermsDays ?? config.termsDays;
      const policyDecisionAt = await this.capturePolicyClock(tx);
      const policyRevision = config.policyRevision + 1;
      await tx.billingAccountCreditConfig.update({
        where: { billingAccountId: candidate.billingAccountId },
        data: {
          status: CREDIT_STATUS_SUSPENDED,
          updatedBy: OVERDUE_ACTOR,
          policyRevision,
          policyEffectiveBoundaryAt: null,
          policyBoundaryComplete: false,
        },
      });
      const event = await tx.billingAccountCreditEvent.create({
        data: {
          billingAccountId: candidate.billingAccountId,
          oldLimitUsd: config.limitUsd,
          newLimitUsd: config.limitUsd,
          oldStatus: CREDIT_STATUS_ACTIVE,
          newStatus: CREDIT_STATUS_SUSPENDED,
          oldTermsDays: config.termsDays,
          newTermsDays: config.termsDays,
          oldEffectiveAt: config.effectiveAt,
          newEffectiveAt: config.effectiveAt,
          oldExpiresAt: config.expiresAt,
          newExpiresAt: config.expiresAt,
          temporalSnapshotComplete: true,
          policyRevision,
          policyDecisionAt,
          policyEffectiveBoundaryAt: null,
          policyBoundaryComplete: false,
          actorId: OVERDUE_ACTOR,
          reason: OVERDUE_REASON,
          note: `未核销信用消费 ${oldest.createdAt.toISOString()} 已于 ${dueAt.toISOString()} 到期`
            + (appliedTermsDays ? `（发生时账期 ${appliedTermsDays} 天）` : '')
            + (graceMs > 0
              ? `；宽限 ${this.overdueGraceHours()} 小时后于 ${enforceAt.toISOString()} 挂起`
              : ''),
        },
      });
      return {
        eventId: event.id,
        policyRevision,
        oldestCreatedAt: oldest.createdAt,
        dueAt,
        enforceAt,
        appliedTermsDays,
      };
    }, WORKER_FINANCIAL_TRANSACTION_OPTIONS);
    if (mutation === 'deferred') {
      enterpriseCreditOverdueSuspendTotal.inc({ outcome: 'deferred_by_grace' });
      return false;
    }
    if (!mutation) return false;
    const stillCurrent = await this.confirmPolicyBoundary(
      candidate.billingAccountId,
      mutation.eventId,
      mutation.policyRevision,
    );
    if (!stillCurrent) return false;
    await enqueueEnterpriseCreditPolicyFanout(this.prisma, this.publisherSync, {
      billingAccountId: candidate.billingAccountId,
      eventId: mutation.eventId,
      policyRevision: mutation.policyRevision,
    });
    enterpriseCreditOverdueSuspendTotal.inc({ outcome: 'suspended' });
    this.logger.warn(
      `enterprise credit overdue: suspended account=${candidate.billingAccountId} ` +
        `oldestUnsettled=${mutation.oldestCreatedAt.toISOString()} dueAt=${mutation.dueAt.toISOString()} `
        + `enforceAt=${mutation.enforceAt.toISOString()} graceHours=${this.overdueGraceHours()} `
        + `termsDays=${mutation.appliedTermsDays ?? 'legacy-unknown'}`,
    );
    await this.recordSuspensionAlert(candidate.billingAccountId, mutation);
    return true;
  }

  /**
   * 把挂起写进 alert_events，让管理端事件流看得见 —— 这是这次事故里唯一缺的
   * 「有人知道」环节（此前只有一行 logger.warn）。
   *
   * 直接用 prisma 写而不注入 AlertEventService：AlertEventsModule 里的 JwtModule
   * 用 getOrThrow('JWT_SECRET')，把它 import 进 billing-runtime 会给 worker pod
   * 增加一个启动硬依赖，不值得为一行审计记录承担这个风险。
   * 去重也不需要 AlertEventService 那个 5 分钟软窗口：config 只会翻一次，
   * sourceId 取 credit event id 天然一账户一次。
   *
   * best-effort：绝不抛。挂起本身已经提交并 fanout 完成，
   * 告警写失败不该把一次成功的风控动作变成失败。
   */
  private async recordSuspensionAlert(
    billingAccountId: string,
    mutation: {
      eventId: string;
      dueAt: Date;
      enforceAt: Date;
      oldestCreatedAt: Date;
      appliedTermsDays: number | null;
    },
  ): Promise<void> {
    try {
      await this.prisma.alertEvent.create({
        data: {
          category: 'SYSTEM',
          severity: 'HIGH',
          title: '企业授信已自动挂起（逾期）',
          message: `账户 ${billingAccountId} 的未核销信用消费已于 `
            + `${mutation.dueAt.toISOString()} 到期，授信已置为 SUSPENDED。`
            + '此后该账户超出已充值余额的用量会被判为未批准欠款并触发 debt_open 关闸（断服）。',
          sourceType: 'billing_account_credit_event',
          sourceId: mutation.eventId,
          context: JSON.stringify({
            billingAccountId,
            creditEventId: mutation.eventId,
            dueAt: mutation.dueAt.toISOString(),
            enforceAt: mutation.enforceAt.toISOString(),
            graceHours: this.overdueGraceHours(),
            oldestUnsettledAt: mutation.oldestCreatedAt.toISOString(),
            appliedTermsDays: mutation.appliedTermsDays,
          }),
        },
      });
    } catch (err) {
      this.logger.warn(
        `enterprise credit suspension alert write failed account=${billingAccountId}: `
        + `${(err as Error).message}`,
      );
    }
  }

  /**
   * 「还有多久被挂起」的观测。复刻 suspendIfOverdue 的 dueAt 判定
   * （min(发生时冻结的 credit_due_at, 存量行 created_at + 当前 termsDays)），
   * 但不持锁 —— 这里只出指标，任何资金判定仍以锁内那份为准。
   *
   * 分档计数交给 Alertmanager 做阈值和去重，所以本方法每轮都把四个档位
   * 显式写一遍（包括 0）：留旧值会让问题消失后告警继续 firing。
   */
  private async observeOverdueHorizon(): Promise<void> {
    try {
      const graceMs = this.overdueGraceHours() * HOUR_MS;
      const rows = await this.prisma.$queryRaw<Array<{ dueAt: Date | null }>>`
        WITH acct AS (
          SELECT config."billing_account_id" AS id, config."terms_days" AS terms_days
          FROM "billing_account_credit_configs" config
          INNER JOIN "billing_accounts" ba
            ON ba."id" = config."billing_account_id"
          INNER JOIN "account_wallets" w
            ON w."billing_account_id" = config."billing_account_id"
          WHERE config."status" = ${CREDIT_STATUS_ACTIVE}
            AND ba."type" = ${ENTERPRISE_ACCOUNT_TYPE}
            AND ba."deleted_at" IS NULL
            AND w."balance_usd" < 0
        )
        SELECT LEAST(
          (
            SELECT min(al."credit_due_at")
            FROM "balance_consumption_allocations" al
            WHERE al."billing_account_id" = acct.id
              AND al."source" = 'ENTERPRISE_CREDIT'
              AND al."settled_at" IS NULL
              AND al."credit_policy_snapshot_complete"
              AND al."credit_due_at" IS NOT NULL
          ),
          CASE WHEN acct.terms_days > 0 THEN (
            SELECT min(al."created_at")
            FROM "balance_consumption_allocations" al
            WHERE al."billing_account_id" = acct.id
              AND al."source" = 'ENTERPRISE_CREDIT'
              AND al."settled_at" IS NULL
              AND NOT al."credit_policy_snapshot_complete"
          ) + make_interval(days => acct.terms_days) END
        ) AS "dueAt"
        FROM acct
        LIMIT ${CANDIDATE_BATCH}
      `;
      const now = Date.now();
      const counts = new Map<string, number>(
        ENTERPRISE_CREDIT_OVERDUE_PHASES.map((phase) => [phase, 0]),
      );
      let earliestEnforceAtMs: number | null = null;
      for (const row of rows) {
        const dueAt = row.dueAt;
        if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) continue;
        const enforceAtMs = dueAt.getTime() + graceMs;
        if (earliestEnforceAtMs === null || enforceAtMs < earliestEnforceAtMs) {
          earliestEnforceAtMs = enforceAtMs;
        }
        const remainingMs = enforceAtMs - now;
        const phase = OVERDUE_PHASE_THRESHOLDS.find(
          (threshold) => remainingMs <= threshold.withinMs,
        )?.phase;
        if (phase) counts.set(phase, (counts.get(phase) ?? 0) + 1);
      }
      for (const phase of ENTERPRISE_CREDIT_OVERDUE_PHASES) {
        enterpriseCreditOverdueAccounts.set({ phase }, counts.get(phase) ?? 0);
      }
      // 无待挂起账户时用一个「明显不临近」的哨兵值，而不是 0 ——
      // 0 在这条 gauge 上的含义是「此刻就该挂起」，会让阈值规则误报。
      // 告警规则应当以 enterpriseCreditOverdueAccounts 的分档计数为准，
      // 本 gauge 主要供看板读「最近的那个日子还有多远」。
      enterpriseCreditEnforcementEarliestSeconds.set(
        earliestEnforceAtMs === null
          ? NO_ENFORCEMENT_PENDING_SECONDS
          : (earliestEnforceAtMs - now) / 1000,
      );
    } catch (err) {
      this.logger.warn(
        `enterprise credit overdue horizon probe failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 当前有多少客户正被 debt_open 关闸，以及最老那条关了多久。
   *
   * 刻意不限定「逾期挂起造成的」：无配置 / SUSPENDED / DISABLED / 零额度 /
   * 过期额度 / 额度耗尽都会建立同样的关闸，而客户感知到的只有「断服」。
   * 最老年龄就是客户可见的断服时钟 —— 2026-08-28 那次会让它涨到 23537 秒。
   */
  private async observeDebtOpenRestrictions(): Promise<void> {
    try {
      const [row] = await this.prisma.$queryRaw<Array<{
        active: bigint;
        oldest: Date | null;
      }>>`
        SELECT count(*)::bigint AS "active", min("created_at") AS "oldest"
        FROM "billing_access_restrictions"
        WHERE "status" = 'ACTIVE' AND "reason" = 'debt_open'
      `;
      const active = Number(row?.active ?? BigInt(0));
      billingDebtOpenRestrictionsActive.set(Number.isFinite(active) ? active : 0);
      const oldest = row?.oldest;
      billingDebtOpenOldestAgeSeconds.set(
        active > 0 && oldest instanceof Date && !Number.isNaN(oldest.getTime())
          ? Math.max(0, (Date.now() - oldest.getTime()) / 1000)
          : 0,
      );
    } catch (err) {
      this.logger.warn(
        `debt_open restriction probe failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 人工恢复授信后的催收豁免截止时刻，从当前 revision 的 credit event 推导。
   *
   * 只有「人工把授信改成 ACTIVE」才给豁免：
   * - reason === overdue_auto_suspend → 无豁免（自动挂起本身不是恢复，
   *   否则 worker 自己挂起后会给自己发豁免，逾期风控直接失效）
   * - newStatus !== ACTIVE            → 无豁免（改成 DISABLED/SUSPENDED 不是恢复）
   *
   * 幂等重放不会绕过：管理端那条 P2002 路径复用的是**原来那条 event**，
   * createdAt 保持首次写入时刻，所以豁免窗口不会被重放刷新。
   */
  private async restoreDeferredUntil(
    tx: Prisma.TransactionClient,
    config: { billingAccountId: string; policyRevision: number },
  ): Promise<Date | null> {
    const hours = this.overdueRestoreDeferralHours();
    if (hours <= 0) return null;
    const event = await tx.billingAccountCreditEvent.findUnique({
      where: {
        billingAccountId_policyRevision: {
          billingAccountId: config.billingAccountId,
          policyRevision: config.policyRevision,
        },
      },
      select: { reason: true, newStatus: true, createdAt: true },
    });
    if (!event) return null;
    if (event.reason === OVERDUE_REASON) return null;
    if (event.newStatus !== CREDIT_STATUS_ACTIVE) return null;
    return new Date(event.createdAt.getTime() + hours * HOUR_MS);
  }

  /**
   * 催收豁免小时数。默认 0 —— 上线后行为与本变量存在前逐位一致；
   * 业务定的 7 天(168)由各环境 ConfigMap 显式配置，代码里不硬编码业务参数。
   * 非法/负值一律回落 0（= 不豁免 = 逾期风控最严），绝不解释成无限豁免。
   */
  private overdueRestoreDeferralHours(): number {
    const raw = this.config.get<string>('ENTERPRISE_CREDIT_OVERDUE_RESTORE_DEFERRAL_HOURS')
      ?? process.env.ENTERPRISE_CREDIT_OVERDUE_RESTORE_DEFERRAL_HOURS;
    const parsed = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * 宽限小时数。默认 0 —— 上线后行为与现状逐位一致，逐环境再配。
   * 非法/负值一律回落 0，绝不放宽到「无限宽限」。
   */
  private overdueGraceHours(): number {
    const raw = this.config.get<string>('ENTERPRISE_CREDIT_OVERDUE_GRACE_HOURS')
      ?? process.env.ENTERPRISE_CREDIT_OVERDUE_GRACE_HOURS;
    const parsed = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private async lockCreditAggregate(
    tx: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<{ walletBalanceUsd: Prisma.Decimal }> {
    const wallet = await tx.$queryRaw<Array<{ walletBalanceUsd: Prisma.Decimal }>>`
      SELECT "balance_usd" AS "walletBalanceUsd"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${billingAccountId}
      FOR UPDATE
    `;
    const account = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${billingAccountId}
      FOR UPDATE
    `;
    if (wallet.length !== 1 || account.length !== 1) {
      throw new Error(`enterprise credit aggregate unavailable: ${billingAccountId}`);
    }
    await tx.$queryRaw`
      SELECT "billing_account_id"
      FROM "billing_account_credit_configs"
      WHERE "billing_account_id" = ${billingAccountId}
      FOR UPDATE
    `;
    return { walletBalanceUsd: new Prisma.Decimal(wallet[0].walletBalanceUsd) };
  }

  private async confirmPreviousBoundaryUnderLock(
    tx: Prisma.TransactionClient,
    billingAccountId: string,
    policyRevision: number,
  ): Promise<void> {
    if (policyRevision <= 0) return;
    const event = await tx.billingAccountCreditEvent.findUnique({
      where: {
        billingAccountId_policyRevision: { billingAccountId, policyRevision },
      },
    });
    if (
      !event
      || !event.temporalSnapshotComplete
      || !(event.policyDecisionAt instanceof Date)
    ) {
      throw new Error(`enterprise credit history boundary unavailable: ${billingAccountId}`);
    }
    if (event.policyBoundaryComplete) {
      if (!(event.policyEffectiveBoundaryAt instanceof Date)) {
        throw new Error(`enterprise credit history boundary timestamp unavailable: ${billingAccountId}`);
      }
      await tx.billingAccountCreditConfig.update({
        where: { billingAccountId },
        data: {
          policyEffectiveBoundaryAt: event.policyEffectiveBoundaryAt,
          policyBoundaryComplete: true,
        },
      });
      return;
    }
    const policyEffectiveBoundaryAt = await this.capturePolicyClock(tx, true);
    const updated = await tx.billingAccountCreditEvent.updateMany({
      where: {
        id: event.id,
        billingAccountId,
        policyRevision,
        policyBoundaryComplete: false,
      },
      data: { policyEffectiveBoundaryAt, policyBoundaryComplete: true },
    });
    if (updated.count !== 1) {
      throw new Error(`enterprise credit history boundary conflict: ${billingAccountId}`);
    }
    await tx.billingAccountCreditConfig.update({
      where: { billingAccountId },
      data: { policyEffectiveBoundaryAt, policyBoundaryComplete: true },
    });
  }

  private async confirmPolicyBoundary(
    billingAccountId: string,
    eventId: string,
    policyRevision: number,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCreditAggregate(tx, billingAccountId);
      const [config, event] = await Promise.all([
        tx.billingAccountCreditConfig.findUnique({ where: { billingAccountId } }),
        tx.billingAccountCreditEvent.findUnique({ where: { id: eventId } }),
      ]);
      if (
        !event
        || event.billingAccountId !== billingAccountId
        || event.policyRevision !== policyRevision
        || !event.temporalSnapshotComplete
        || !(event.policyDecisionAt instanceof Date)
      ) {
        throw new Error(`enterprise credit commit boundary unavailable: ${billingAccountId}`);
      }
      if (event.policyBoundaryComplete) {
        if (!(event.policyEffectiveBoundaryAt instanceof Date)) {
          throw new Error(`enterprise credit commit boundary timestamp unavailable: ${billingAccountId}`);
        }
        if (config?.policyRevision !== policyRevision) return false;
        await tx.billingAccountCreditConfig.update({
          where: { billingAccountId },
          data: {
            policyEffectiveBoundaryAt: event.policyEffectiveBoundaryAt,
            policyBoundaryComplete: true,
          },
        });
        return true;
      }
      if (!config) {
        throw new Error(`enterprise credit config unavailable: ${billingAccountId}`);
      }
      if (config.policyRevision !== policyRevision) return false;
      const policyEffectiveBoundaryAt = await this.capturePolicyClock(tx, true);
      const updated = await tx.billingAccountCreditEvent.updateMany({
        where: {
          id: eventId,
          billingAccountId,
          policyRevision,
          policyBoundaryComplete: false,
        },
        data: { policyEffectiveBoundaryAt, policyBoundaryComplete: true },
      });
      if (updated.count !== 1) {
        throw new Error(`enterprise credit commit boundary conflict: ${billingAccountId}`);
      }
      await tx.billingAccountCreditConfig.update({
        where: { billingAccountId },
        data: { policyEffectiveBoundaryAt, policyBoundaryComplete: true },
      });
      return true;
    }, WORKER_FINANCIAL_TRANSACTION_OPTIONS);
  }

  private async capturePolicyClock(
    tx: Prisma.TransactionClient,
    visibilityBoundary = false,
  ): Promise<Date> {
    const rows = visibilityBoundary
      ? await tx.$queryRaw<Array<{ policyClock: Date }>>`
          SELECT (
            date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
            + INTERVAL '1 millisecond'
          )::TIMESTAMP(3) AS "policyClock"
        `
      : await tx.$queryRaw<Array<{ policyClock: Date }>>`
          SELECT date_trunc(
            'milliseconds',
            clock_timestamp() AT TIME ZONE 'UTC'
          )::TIMESTAMP(3) AS "policyClock"
        `;
    const policyClock = rows[0]?.policyClock;
    if (!(policyClock instanceof Date) || Number.isNaN(policyClock.getTime())) {
      throw new Error('enterprise credit database clock unavailable');
    }
    return policyClock;
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('ENTERPRISE_CREDIT_OVERDUE_ENABLED')
      ?? process.env.ENTERPRISE_CREDIT_OVERDUE_ENABLED;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['false', '0', 'off', 'no'].includes(String(raw).toLowerCase());
  }

  private intervalMs(): number {
    const raw = Number(
      this.config.get<string>('ENTERPRISE_CREDIT_OVERDUE_INTERVAL_MS')
        ?? process.env.ENTERPRISE_CREDIT_OVERDUE_INTERVAL_MS,
    );
    // This worker also repairs current policy boundaries and Publisher fanout.
    // Keep the default recovery SLO at one minute so a crashed credit decrease
    // cannot leave stale high-credit Gateway state for the former 1-hour sweep.
    return Number.isFinite(raw) && raw >= 60_000 ? raw : 60_000;
  }

  private startupDelayMs(): number {
    return 30_000;
  }

  private async acquireLock(token: string): Promise<boolean> {
    try {
      const ok = await this.redis.set(this.lockKey, token, 'PX', this.intervalMs(), 'NX');
      return ok === 'OK';
    } catch (err) {
      this.logger.warn(`overdue worker lock acquire failed: ${(err as Error).message}`);
      return false;
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey, token);
    } catch (err) {
      this.logger.warn(`overdue worker lock release failed: ${(err as Error).message}`);
    }
  }
}
