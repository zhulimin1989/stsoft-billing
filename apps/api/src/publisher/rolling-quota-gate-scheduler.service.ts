import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import { rollingQuotaGateEnabled } from '../quota-templates/plan-quota-rule-views';
import { PublisherClient } from './publisher.client';
import { PublisherSyncService } from './publisher-sync.service';
import { ROLLING_QUOTA_GATED_ZSET } from './rolling-quota-gate.service';

const POLL_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 45_000;
const BATCH = 200;

/**
 * P1-C 解封 / 回滚调度：轮询 cpq:gated（被滚动配额关闸的 key → 下次重判时间 score）。
 * - 总开关开启：处理到期(score<=now)的 key，重跑 syncKeyBalanceById——配额恢复则其内部 ZREM 并放行，
 *   仍超限则以新 score 重登记。
 * - 总开关关闭（回滚）：drain 整个 cpq:gated，逐个 ZREM 后重跑 syncKeyBalanceById，按真实资金恢复
 *   has_balance（否则关闸下发的 has_balance=false 永不解封，开关就不是有效回滚）。
 * 仅在 billing runtime 运行。防重入；模块销毁时清理 timer。
 */
@Injectable()
export class RollingQuotaGateSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RollingQuotaGateSchedulerService.name);
  private running = false;
  private interval?: ReturnType<typeof setInterval>;
  private initialTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly redis: RedisService,
    private readonly publisherSync: PublisherSyncService,
    private readonly publisher: PublisherClient,
  ) {}

  onModuleInit() {
    if (!isBillingRuntime()) {
      this.logger.log('Skip rolling-quota unblock worker outside billing runtime');
      return;
    }
    if (this.publisher.isNetworkDisabled()) {
      this.logger.log('Skip rolling-quota unblock worker while Publisher network is disabled');
      return;
    }
    this.interval = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.initialTimer = setTimeout(() => void this.tick(), INITIAL_DELAY_MS);
  }

  onModuleDestroy() {
    if (this.interval) clearInterval(this.interval);
    if (this.initialTimer) clearTimeout(this.initialTimer);
  }

  async tick(): Promise<void> {
    if (this.publisher.isNetworkDisabled()) return;
    if (this.running) return; // 防重入：上一轮未跑完则跳过本次
    this.running = true;
    try {
      const gateOn = rollingQuotaGateEnabled();
      const now = Date.now();
      // 开关开：只取到期项；开关关（回滚）：取全部以尽快 drain。
      const members = gateOn
        ? await this.redis.zrangebyscore(ROLLING_QUOTA_GATED_ZSET, 0, now, 'LIMIT', 0, BATCH)
        : await this.redis.zrange(ROLLING_QUOTA_GATED_ZSET, 0, BATCH - 1);
      if (!members || members.length === 0) return;
      for (const keyId of members) {
        try {
          if (!gateOn) {
            // 回滚：先摘除，syncKeyBalanceById（开关关）将按真实资金重算 has_balance 恢复放行。
            await this.redis.zrem(ROLLING_QUOTA_GATED_ZSET, keyId).catch(() => undefined);
          }
          await this.publisherSync.syncKeyBalanceById(keyId, { deleteWhenMissing: false });
        } catch (err) {
          this.logger.warn(
            `rolling quota ${gateOn ? 'unblock' : 'drain'} recheck failed key=${keyId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      this.logger.debug(
        `rolling quota ${gateOn ? 'unblock' : 'drain'} rechecked ${members.length} key(s)`,
      );
    } catch (err) {
      this.logger.error(
        `rolling quota unblock tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
