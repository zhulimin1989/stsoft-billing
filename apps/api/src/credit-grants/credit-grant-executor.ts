/**
 * CreditGrantExecutor — runs a single CreditGrantRule end-to-end.
 *
 * Flow (per spec §7.3):
 *   1. Resolve target userIds (segment-aware).
 *   2. Apply globalDailyCap (caps the TOTAL granted AMOUNT per execution,
 *      not the user count — `granted += rewardAmount; if (granted >= cap) break`).
 *   3. For each user, in transaction:
 *      - Skip if user already hit perUserLimit today for this rule.
 *      - Compute expiresAt from expirePolicy.
 *      - Insert CreditTransaction(type=GRANT, expiresAt, grantRuleId).
 *      - Insert GrantRedemption(rule, user, amount, expiresAt, txId).
 *   4. Update rule.lastTriggeredAt + return per-rule metrics.
 *
 * Notes:
 *  - PR0-1: rewardType=CREDIT 现在会同步把 amount 加进 Redis grant 池
 *    (`credit:user:{userId}:grant`),CreditService.deduct 会在 bonus / quota
 *    之前优先扣 grant 池(详见 credit.service.ts 头部注释)。如果 Redis 写
 *    失败,我们记 warn 但不回滚 PG —— 池余额可由 reconcile worker 后续修复,
 *    定时奖励发放本身已在账本上落地。
 *  - rewardType=BALANCE 暂停执行。BALANCE 奖励需要单独完成账务模型设计；
 *    当前执行器必须在任何 CreditTransaction、GrantRedemption、钱包或批次
 *    写入前失败关闭，不能沿用旧的跨事务钱包更新。
 *  - rewardType=BOOSTER_PACK remains unsupported by this schema: there is no
 *    boosterPackId / SKU binding on CreditGrantRule, so the executor fails
 *    fast instead of writing misleading redemption audit rows.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  CreditGrantRule,
  CreditTransaction,
  GrantRedemption,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditGrantsService } from './credit-grants.service';

export interface ExecuteRuleResult {
  ruleId: string;
  attemptedUsers: number;
  granted: number;
  skippedPerUserLimit: number;
  skippedCap: number;
  failed: number;
  totalAmount: number;
}

type GrantOutcome =
  | { status: 'granted'; tx: CreditTransaction; redemption: GrantRedemption }
  | { status: 'skipped_per_user_limit' }
  | { status: 'skipped_cap' };

@Injectable()
export class CreditGrantExecutor {
  private readonly logger = new Logger(CreditGrantExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: CreditGrantsService,
    private readonly redis: RedisService,
  ) {}

  /** PR0-1: GRANT 池 Redis key(用户级) */
  private grantKey(userId: string): string {
    return `credit:user:${userId}:grant`;
  }

  /**
   * Execute a single rule. Caller is responsible for picking which rules to
   * fire (BullMQ cron job iterates active DAILY_CRON / WEEKLY_CRON rules).
   *
   * Idempotency: per-user-per-day and globalDailyCap are enforced again
   * inside the per-user transaction under a rule/day advisory lock. This
   * removes the prior cron/manual race where two workers could both pass the
   * pre-read and insert duplicate redemptions.
   */
  async executeRule(
    rule: CreditGrantRule,
    opts: { now?: Date; manualTrigger?: boolean } = {},
  ): Promise<ExecuteRuleResult> {
    const now = opts.now ?? new Date();

    // 1. Soft window check.
    if (rule.startAt && now.getTime() < rule.startAt.getTime()) {
      this.logger.log(`rule=${rule.id} not yet active (startAt in future)`);
      return this.zeroResult(rule.id);
    }
    if (rule.endAt && now.getTime() >= rule.endAt.getTime()) {
      this.logger.log(`rule=${rule.id} expired (endAt passed)`);
      return this.zeroResult(rule.id);
    }
    if (!rule.isActive || rule.deletedAt) {
      return this.zeroResult(rule.id);
    }

    // 2. Resolve target users.
    const userIds = await this.service.resolveTargetUserIds(rule.segmentId);
    if (userIds.length === 0) {
      await this.markTriggered(rule.id, now);
      return this.zeroResult(rule.id);
    }

    // BALANCE 发奖的完整财务模型后续另案设计。旧实现会先提交奖励流水、
    // 再在事务外改钱包，无法满足当前余额批次账本的不变量；因此在任何
    // 单用户写入、开户或重试前整条规则失败关闭。
    if (rule.rewardType === 'BALANCE') {
      this.logger.error(
        `rule=${rule.id} rewardType=BALANCE is deferred pending a dedicated financial design.`,
      );
      await this.markTriggered(rule.id, now);
      return {
        ruleId: rule.id,
        attemptedUsers: userIds.length,
        granted: 0,
        skippedPerUserLimit: 0,
        skippedCap: 0,
        failed: userIds.length,
        totalAmount: 0,
      };
    }

    if (rule.rewardType === 'BOOSTER_PACK') {
      this.logger.error(
        `rule=${rule.id} rewardType=BOOSTER_PACK is unsupported by CreditGrantRule schema; refusing to create no-op redemptions.`,
      );
      await this.markTriggered(rule.id, now);
      return {
        ruleId: rule.id,
        attemptedUsers: userIds.length,
        granted: 0,
        skippedPerUserLimit: 0,
        skippedCap: 0,
        failed: userIds.length,
        totalAmount: 0,
      };
    }

    // 3. Pre-check today's already-granted redemptions for this rule. We pull
    //    all userIds in one query rather than per-user to avoid N+1.
    const candidateIds = userIds;
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const alreadyToday = await this.prisma.grantRedemption.findMany({
      where: {
        ruleId: rule.id,
        userId: { in: candidateIds },
        createdAt: { gte: todayStart },
      },
      select: { userId: true },
    });
    const alreadyCount = new Map<string, number>();
    for (const r of alreadyToday) {
      alreadyCount.set(r.userId, (alreadyCount.get(r.userId) ?? 0) + 1);
    }

    // 4. Iterate. We do NOT use a giant outer transaction — per-user
    //    transactions keep the failure radius small and the cron loop fast.
    //
    //    globalDailyCap semantics (spec §7.3): the cap is the total AMOUNT
    //    granted for the rule/day, NOT the number of users. The transaction
    //    rechecks the authoritative total under a rule/day advisory lock.
    let granted = 0;
    let skippedPerUserLimit = 0;
    let failed = 0;
    let totalAmount = 0;
    let capHit = false;
    let processedCount = 0;

    for (const userId of candidateIds) {
      processedCount++;
      const count = alreadyCount.get(userId) ?? 0;
      if (count >= rule.perUserLimit) {
        skippedPerUserLimit++;
        continue;
      }
      const expiresAt = this.service.computeExpiresAt(
        rule.expirePolicy,
        rule.expireDays ?? null,
        now,
      );
      try {
        const outcome = await this.grantToUser({
          rule,
          userId,
          amount: rule.rewardAmount,
          expiresAt,
          limits: {
            windowStart: todayStart,
            perUserLimit: rule.perUserLimit,
            globalDailyCap: rule.globalDailyCap,
          },
        });
        if (outcome.status === 'skipped_per_user_limit') {
          skippedPerUserLimit++;
          continue;
        }
        if (outcome.status === 'skipped_cap') {
          capHit = true;
          break;
        }
        granted++;
        totalAmount += rule.rewardAmount;
      } catch (err) {
        failed++;
        this.logger.error(
          `grant failed: rule=${rule.id} user=${userId} err=${(err as Error).message}`,
        );
      }
    }

    const skippedCap = capHit ? candidateIds.length - processedCount + 1 : 0;

    await this.markTriggered(rule.id, now);

    return {
      ruleId: rule.id,
      attemptedUsers: candidateIds.length,
      granted,
      skippedPerUserLimit,
      skippedCap,
      failed,
      totalAmount,
    };
  }

  /**
   * Public entry point for one-shot single-user grants (P2-D Referrals).
   *
   * Used by ReferralsService when an attribution / order trigger fires:
   * we need to hand out the inviter / invitee reward without iterating a
   * segment or going through executeRule's cap / per-user-limit logic
   * (per-user-limit on the hidden referral GrantRule is already enforced
   * by ReferralRedemption uniqueness — one row per (program, invitee)).
   *
   * Computes expiresAt from the rule's expirePolicy + expireDays, then
   * delegates to the private grantToUser path. BALANCE rewards fail closed
   * here before any lookup or write until their accounting model is designed.
   */
  async grantToUserDirect(
    rule: CreditGrantRule,
    userId: string,
    opts: { now?: Date } = {},
  ): Promise<{ tx: CreditTransaction; redemption: GrantRedemption }> {
    if (rule.rewardType === 'BALANCE') {
      throw new Error(`BALANCE reward rule ${rule.id} is deferred`);
    }
    const now = opts.now ?? new Date();
    const expiresAt = this.service.computeExpiresAt(
      rule.expirePolicy,
      rule.expireDays ?? null,
      now,
    );
    const outcome = await this.grantToUser({
      rule,
      userId,
      amount: rule.rewardAmount,
      expiresAt,
    });
    if (outcome.status !== 'granted') {
      throw new Error(
        `direct grant unexpectedly skipped: rule=${rule.id} user=${userId} status=${outcome.status}`,
      );
    }
    return { tx: outcome.tx, redemption: outcome.redemption };
  }

  /**
   * Single-user grant — one PG transaction writes both the credit transaction
   * and the redemption row, then PR0-1 increments the Redis grant pool so the
   * granted amount is immediately available for deduction.
   *
   * Redis 写在 PG 之后 —— 顺序要紧:即便 Redis 失败,PG 行也存在,reconcile
   * worker 可基于 GrantRedemption.amount - usedAmount 把池子重建出来。反之,
   * 先写 Redis 再 PG 失败会导致用户看见多余余额。
   *
   * BALANCE 在入口和这里双重失败关闭，避免将来有调用方绕过规则级校验。
   */
  private async grantToUser(args: {
    rule: CreditGrantRule;
    userId: string;
    amount: number;
    expiresAt: Date | null;
    limits?: {
      windowStart: Date;
      perUserLimit: number;
      globalDailyCap: number | null;
    };
  }): Promise<GrantOutcome> {
    const { rule, userId, amount, expiresAt, limits } = args;

    if (rule.rewardType === 'BALANCE') {
      throw new Error(`BALANCE reward rule ${rule.id} is deferred`);
    }

    if (rule.rewardType === 'BOOSTER_PACK') {
      throw new Error(
        `BOOSTER_PACK reward rule ${rule.id} is unsupported by CreditGrantRule schema`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      if (limits) {
        const periodKey = limits.windowStart.toISOString().slice(0, 10);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit-grant:${rule.id}:${periodKey}`}))`;

        const userRedemptions = await tx.grantRedemption.count({
          where: {
            ruleId: rule.id,
            userId,
            createdAt: { gte: limits.windowStart },
          },
        });
        if (userRedemptions >= limits.perUserLimit) {
          return { status: 'skipped_per_user_limit' } as const;
        }

        if (limits.globalDailyCap != null) {
          const totalToday = await tx.grantRedemption.aggregate({
            where: {
              ruleId: rule.id,
              createdAt: { gte: limits.windowStart },
            },
            _sum: { amount: true },
          });
          const grantedToday = totalToday._sum.amount ?? 0;
          if (grantedToday + amount > limits.globalDailyCap) {
            return { status: 'skipped_cap' } as const;
          }
        }
      }

      const created = await tx.creditTransaction.create({
        data: {
          userId,
          type: 'GRANT',
          creditsAmount: amount,
          source: `grant-rule:${rule.id}`,
          productId: rule.productId ?? undefined,
          expiresAt,
          grantRuleId: rule.id,
          // quotaAfter / bonusAfter 留 0:GRANT 走独立的 grant 池,不污染现有快照。
        },
      });
      const redemption = await tx.grantRedemption.create({
        data: {
          ruleId: rule.id,
          userId,
          amount,
          expiresAt,
          txId: created.id,
        },
      });

      return { status: 'granted', tx: created, redemption } as const;
    });

    if (result.status !== 'granted') {
      return result;
    }

    // PR0-1: 同步 grant 池。仅 CREDIT 奖励类型加池。
    if (rule.rewardType === 'CREDIT' && amount > 0) {
      try {
        await this.redis.incrby(this.grantKey(userId), amount);
      } catch (err) {
        this.logger.warn(
          `grant pool incrby failed user=${userId} amount=${amount} rule=${rule.id}: ${(err as Error).message}`,
        );
      }
    }

    return result;
  }

  private async markTriggered(ruleId: string, now: Date): Promise<void> {
    try {
      await this.prisma.creditGrantRule.update({
        where: { id: ruleId },
        data: { lastTriggeredAt: now },
      });
    } catch (err) {
      this.logger.warn(
        `failed to mark rule=${ruleId} as triggered: ${(err as Error).message}`,
      );
    }
  }

  private zeroResult(ruleId: string): ExecuteRuleResult {
    return {
      ruleId,
      attemptedUsers: 0,
      granted: 0,
      skippedPerUserLimit: 0,
      skippedCap: 0,
      failed: 0,
      totalAmount: 0,
    };
  }

  /** Iterate every active rule of a given trigger type and fire it. */
  async executeAllByTrigger(
    triggerType: CreditGrantRule['triggerType'],
    now: Date = new Date(),
  ): Promise<ExecuteRuleResult[]> {
    const rules = await this.prisma.creditGrantRule.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        triggerType,
      },
    });
    const out: ExecuteRuleResult[] = [];
    for (const rule of rules) {
      try {
        out.push(await this.executeRule(rule, { now }));
      } catch (err) {
        this.logger.error(
          `executeAllByTrigger failed: rule=${rule.id} err=${(err as Error).message}`,
        );
        out.push({ ...this.zeroResult(rule.id), failed: 1 });
      }
    }
    return out;
  }
}
