import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { BillingService } from './billing.service';
import { isBillingRuntime } from '../common/runtime/service-role';

/**
 * 议题二批一：企业开通回收的**提交后 fanout** worker。
 * 设计依据：me/payg-multiplier-verify-timeout-v2.md §2.2b「提交后 fanout 的物理契约」。
 *
 * 为什么需要它（不是"顺手做一下缓存同步"）：
 * - `syncBillingAccountKeyBalances(accountId)` 按「当前仍绑定该账户的 tenant」查 key。
 *   detach **提交之后**，被解绑的那个 tenant 已不在查询范围内 ⇒ 它名下 key 的
 *   `has_balance` 投影**根本不会被重算**，旧值永久残留。故被解绑 tenant 的 key 必须**按 keyId** 单独重算。
 * - `fanoutAccountKeyBalances()` catch 后仅告警并正常返回 ⇒ 把"返回"当成功会**误标 DONE**。
 *   本 worker 一律走 `*Required` 变体（失败会抛），失败则保留 PENDING 重放。
 *
 * 生命周期：`PENDING` → `DONE`（**保留行，不删除**）；达 `max_attempts` → `ALERTED`（不可领取，人工复位）。
 */
@Injectable()
export class EnterpriseRecoveryFanoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EnterpriseRecoveryFanoutService.name);
  private readonly leaseMs: number;
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  /** single-flight：上一轮未跑完不重叠触发（避免同实例内自相争抢租约）。 */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisherSync: PublisherSyncService,
    private readonly billing: BillingService,
    private readonly cfg: ConfigService,
  ) {
    const raw = Number.parseInt(this.cfg.get<string>('ENTERPRISE_RECOVERY_FANOUT_LEASE_MS') ?? '', 10);
    this.leaseMs = Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  }

  onModuleInit(): void {
    // 只在 billing runtime 起（与本仓既有 worker 一致；admin/openapi 角色不跑）。
    if (!isBillingRuntime()) {
      this.logger.log('Skip enterprise recovery fanout worker outside billing runtime');
      return;
    }
    const intervalMs = this.intervalMs();
    this.interval = setInterval(() => {
      void this.runOnce('interval');
    }, intervalMs);
    this.interval.unref?.();
    // 启动扫描：进程重启后立刻收敛崩溃残留的 PENDING（这是"崩溃恢复"契约的实际兑现点）。
    this.startupTimer = setTimeout(() => {
      void this.runOnce('startup');
    }, this.startupDelayMs());
    this.startupTimer.unref?.();
    this.logger.log(`scheduled enterprise recovery fanout worker intervalMs=${intervalMs}`);
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

  async runOnce(trigger = 'manual'): Promise<{ processed: number; failed: number; skipped: boolean }> {
    if (this.running) return { processed: 0, failed: 0, skipped: true };
    this.running = true;
    try {
      const r = await this.drain(this.batchSize());
      if (r.processed || r.failed) {
        this.logger.log(
          `enterprise recovery fanout done trigger=${trigger} processed=${r.processed} failed=${r.failed}`,
        );
      }
      return { ...r, skipped: false };
    } catch (err) {
      this.logger.error(`enterprise recovery fanout run failed trigger=${trigger}: ${err}`);
      return { processed: 0, failed: 0, skipped: false };
    } finally {
      this.running = false;
    }
  }

  private intervalMs(): number {
    const raw = Number.parseInt(this.cfg.get<string>('ENTERPRISE_RECOVERY_FANOUT_INTERVAL_MS') ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
  }

  private startupDelayMs(): number {
    const raw = Number.parseInt(this.cfg.get<string>('ENTERPRISE_RECOVERY_FANOUT_STARTUP_DELAY_MS') ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 5_000;
  }

  private batchSize(): number {
    const raw = Number.parseInt(this.cfg.get<string>('ENTERPRISE_RECOVERY_FANOUT_BATCH') ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 20;
  }

  /** 领取并处理至多 `max` 个作业。返回实际成功处理数。 */
  async drain(max = 20): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < max; i += 1) {
      const claimed = await this.claimOne();
      if (!claimed) break;
      const ok = await this.runOne(claimed);
      if (ok) processed += 1;
      else failed += 1;
    }
    return { processed, failed };
  }

  /**
   * claim：沿用本仓既有 job worker 的 **`updateMany` 条件更新**模式
   * （`publisher-sync-job.service.ts` 就是这么做的），**不引入本仓零先例的 `FOR UPDATE SKIP LOCKED`**。
   * `lease_token` 由应用层生成，与 `locked_at` 在**同一条** UPDATE 里写入 ⇒ 原子性由单条语句保证。
   */
  private async claimOne(): Promise<
    | {
        id: string;
        leaseToken: string;
        kind: string;
        accountId: string | null;
        tenantId: string | null;
        apiKeyId: string | null;
        attempts: number;
        maxAttempts: number;
      }
    | null
  > {
    const now = new Date();
    const leaseExpiredBefore = new Date(now.getTime() - this.leaseMs);
    const candidate = await this.prisma.enterpriseRecoveryFanoutJob.findFirst({
      where: {
        status: 'PENDING',
        nextRunAt: { lte: now },
        OR: [{ lockedAt: null }, { lockedAt: { lte: leaseExpiredBefore } }],
      },
      orderBy: { nextRunAt: 'asc' },
      select: {
        id: true, kind: true, accountId: true, tenantId: true, apiKeyId: true,
        attempts: true, maxAttempts: true,
      },
    });
    if (!candidate) return null;

    const leaseToken = randomUUID();
    const claimed = await this.prisma.enterpriseRecoveryFanoutJob.updateMany({
      where: {
        id: candidate.id,
        status: 'PENDING',
        attempts: candidate.attempts,
        OR: [{ lockedAt: null }, { lockedAt: { lte: leaseExpiredBefore } }],
      },
      data: { lockedAt: now, leaseToken },
    });
    // 0 行 ⇒ 被别的 worker 抢先，本轮放弃（不重试覆盖）。
    if (claimed.count !== 1) return null;
    return { ...candidate, leaseToken };
  }

  private async runOne(job: {
    id: string;
    leaseToken: string;
    kind: string;
    accountId: string | null;
    tenantId: string | null;
    apiKeyId: string | null;
    attempts: number;
    maxAttempts: number;
  }): Promise<boolean> {
    try {
      await this.dispatch(job);
    } catch (err) {
      const attempts = job.attempts + 1;
      const exhausted = attempts >= job.maxAttempts;
      // 终态写回必须带 lease 所有权 CAS：0 行 ⇒ 本 worker 已失去所有权，
      // 丢弃本次结果、**不得覆盖接管者**。
      const failWrite = await this.prisma.enterpriseRecoveryFanoutJob.updateMany({
        where: { id: job.id, leaseToken: job.leaseToken },
        data: {
          status: exhausted ? 'ALERTED' : 'PENDING',
          attempts,
          lastError: (err as Error).message?.slice(0, 500) ?? 'unknown',
          // 指数退避，上限 30 分钟。
          nextRunAt: new Date(Date.now() + Math.min(2 ** attempts * 1000, 1_800_000)),
          lockedAt: null,
          leaseToken: null,
        },
      });
      // 只有 CAS 成功（本 worker 仍持有租约）才认定状态已被本次写入。
      if (exhausted && failWrite.count === 1) {
        this.logger.error(
          `enterprise recovery fanout ALERTED job=${job.id} kind=${job.kind} attempts=${attempts}: ${(err as Error).message}`,
        );
      }
      return false;
    }

    const done = await this.prisma.enterpriseRecoveryFanoutJob.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: { status: 'DONE', lockedAt: null, leaseToken: null, lastError: null },
    });
    if (done.count !== 1) {
      // 副作用已执行但所有权已失去：本 worker 不写 DONE，交由持有者收敛。
      // 消费副作用是"按当前状态重算"，重复执行收敛同一结果，故安全。
      // ⚠️ 不计入 processed —— 本轮并没有推进这个 job 的状态。
      this.logger.warn(`enterprise recovery fanout lost lease after success job=${job.id}`);
      return false;
    }
    return true;
  }

  private async dispatch(job: {
    kind: string;
    accountId: string | null;
    tenantId: string | null;
    apiKeyId: string | null;
  }): Promise<void> {
    switch (job.kind) {
      case 'KEY_BY_ID':
        // 被解绑 tenant 名下的 key：其 tenant 已无 billing account，
        // 故用 by-keyId 的 Required 原语（deleteWhenMissing 与本仓既有用法一致）。
        // ⚠️ 不能用 syncBillingAccountKeyBalancesByTenantIdRequired——它在 tenant
        // 无 billing account 时**直接抛错**。
        await this.publisherSync.syncKeyBalanceByIdRequired(
          job.apiKeyId as string,
          { deleteWhenMissing: true },
        );
        return;
      case 'TENANT_CACHE':
        // tenant 缓存同步的归属是 BillingService（publisher-sync 上没有这个方法）。
        await this.billing.syncTenantBalanceCacheForCurrentBinding(job.tenantId as string);
        return;
      case 'ACCOUNT':
        await this.publisherSync.syncBillingAccountKeyBalancesRequired(job.accountId as string);
        return;
      default:
        throw new Error(`unknown fanout kind: ${job.kind}`);
    }
  }
}
