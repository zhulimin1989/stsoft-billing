/**
 * CreditExpireService — daily sweep that reverses unused GRANT credits.
 *
 * PR0-1 流转(取代 PR5 的"假冲销"策略):
 *   1. Find GrantRedemption rows where:
 *        expiresAt < now AND isExpired=false AND isUsedUp=false
 *   2. For each row:
 *        - remaining = amount - usedAmount (真实可冲销额度)
 *        - 写反向 CreditTransaction(type=EXPIRE, creditsAmount=-remaining,
 *          grantRuleId=row.ruleId, source="expire:<grantTxId>")
 *        - 标记原 GRANT CreditTransaction.isExpired=true(若 txId 存在)
 *        - 标记 GrantRedemption.isExpired=true
 *        - PG 成功后从 Redis grant 池 decrby remaining(原子,负值时回写 0 + warn)
 *   3. 已用尽(isUsedUp=true)的 GrantRedemption 不需要冲销(已经被扣掉了),
 *      仍然把过期标记打上,避免下次扫描重复处理。
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface ExpireSweepResult {
  scanned: number;
  expired: number;
  failed: number;
  totalReversed: number;
}

@Injectable()
export class CreditExpireService {
  private readonly logger = new Logger(CreditExpireService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** PR0-1: GRANT 池 Redis key(用户级) */
  private grantKey(userId: string): string {
    return `credit:user:${userId}:grant`;
  }

  async sweep(now: Date = new Date()): Promise<ExpireSweepResult> {
    const candidates = await this.prisma.grantRedemption.findMany({
      where: {
        isExpired: false,
        expiresAt: { lt: now, not: null },
      },
      include: {
        rule: { select: { productId: true } },
      },
      orderBy: { expiresAt: 'asc' },
      take: 5000, // Cap each sweep so a backlog can't OOM the worker.
    });

    let expired = 0;
    let failed = 0;
    let totalReversed = 0;

    for (const g of candidates) {
      try {
        const remaining = Math.max(0, g.amount - g.usedAmount);

        // 已用尽 / 零额度:仅打过期标,不冲销,不动池
        if (remaining <= 0 || g.isUsedUp) {
          await this.prisma.grantRedemption.update({
            where: { id: g.id },
            data: { isExpired: true },
          });
          continue;
        }

        // 1. PG: 写反向 EXPIRE 流水 + 标记 GrantRedemption + 关联 GRANT 行 isExpired。
        // PG 先成功，避免进程在 Redis decrby 后崩溃导致下次 sweep 二次扣池。
        await this.prisma.$transaction(async (db) => {
          await db.creditTransaction.create({
            data: {
              userId: g.userId,
              type: 'EXPIRE',
              creditsAmount: -remaining,
              source: `expire:${g.txId ?? g.id}`,
              grantRuleId: g.ruleId,
              productId: g.rule?.productId ?? undefined,
              // 不带 expiresAt
            },
          });
          if (g.txId) {
            await db.creditTransaction.update({
              where: { id: g.txId },
              data: { isExpired: true },
            });
          }
          await db.grantRedemption.update({
            where: { id: g.id },
            data: { isExpired: true },
          });
        });
        expired++;
        totalReversed += remaining;

        // 2. Redis grant 池同步。失败不会重开 PG 过期流程，后续 reconcile worker
        // 会以 GrantRedemption / CreditTransaction 为权威源修正缓存。
        try {
          const after = (await this.redis.decrby(this.grantKey(g.userId), remaining)) as number;
          if (typeof after === 'number' && after < 0) {
            await this.redis.set(this.grantKey(g.userId), '0');
            this.logger.warn(
              `grant pool went negative for user=${g.userId} (after decrby ${remaining}); reset to 0`,
            );
          }
        } catch (err) {
          failed++;
          this.logger.error(
            `grant pool decrby failed user=${g.userId} remaining=${remaining}: ${(err as Error).message}; PG expire already committed; reconcile worker must repair Redis.`,
          );
        }
      } catch (err) {
        failed++;
        this.logger.error(
          `expire sweep failed for grantRedemption=${g.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `expire sweep: scanned=${candidates.length} expired=${expired} failed=${failed} reversed=${totalReversed}`,
    );
    return {
      scanned: candidates.length,
      expired,
      failed,
      totalReversed,
    };
  }
}
