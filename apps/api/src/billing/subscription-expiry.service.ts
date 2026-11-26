import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { creditBalanceCacheKey } from './credit-balance-state.service';

@Injectable()
export class SubscriptionExpiryService implements OnModuleInit {
  private readonly logger = new Logger(SubscriptionExpiryService.name);

  constructor(
    private readonly subscriptionLifecycle: SubscriptionLifecycleService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    if (!isBillingRuntime()) {
      this.logger.log('Skip subscription expiry worker outside billing runtime');
      return;
    }
    setInterval(() => this.checkExpiredSubscriptions(), 3600_000);
    setTimeout(() => this.checkExpiredSubscriptions(), 30_000);
  }

  async checkExpiredSubscriptions() {
    try {
      const now = new Date();
      const expired = await this.subscriptionLifecycle.expireDue(now);

      if (expired.length === 0) return;

      // 清理过期订阅的 Redis 缓存
      for (const sub of expired) {
        await this.clearSubscriptionCaches(sub.id, sub.userId, sub.productId).catch((err) =>
          this.logger.warn(`清理缓存失败 subscriptionId=${sub.id}: ${err}`),
        );
      }

      this.logger.log(`已过期 ${expired.length} 个订阅`);
    } catch (err) {
      this.logger.error(`订阅过期检查失败: ${err}`);
    }
  }

  /**
   * 清理订阅相关的 Redis 缓存：
   * - subscription resolver 缓存: sub:{userId}:{productId}
   * - V2 权威余额缓存: credits:v2:{subscriptionId}
   * - 灰度兼容期同时清理旧 quota/bonus key
   */
  private async clearSubscriptionCaches(subscriptionId: string, userId: string, productId: string): Promise<void> {
    const keys = [
      `sub:${userId}:${productId}`,
      creditBalanceCacheKey(subscriptionId),
      `credits:quota:${subscriptionId}`,
      `credits:bonus:${subscriptionId}`,
    ];
    await this.redis.del(...keys);
    this.logger.debug(`已清理过期订阅缓存 subscriptionId=${subscriptionId} keys=${keys.join(',')}`);
  }
}
