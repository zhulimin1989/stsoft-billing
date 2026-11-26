import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import {
  coerceGateBool,
} from './rolling-quota-gate-config.service';
import { setSelfopNegativeDeductOverride } from '../quota-templates/plan-quota-rule-views';
import { isBillingRuntime } from '../common/runtime/service-role';

/** SystemConfig key：自营积分负额扣款（R6）的运行时 admin 开关（DB 支撑，无需改 GitOps env）。 */
export const SELFOP_NEGATIVE_DEDUCT_CONFIG_KEY = 'selfop_negative_deduct_enabled';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * 把 SystemConfig['selfop_negative_deduct_enabled'] 定时（+即时）刷新到 plan-quota-rule-views
 * 的模块级 override，使同步的 selfopNegativeDeductEnabled() 在多副本下也能在 ~30s 内看到 admin 改动。
 * 与 RollingQuotaGateConfigService 同构：仅 billing runtime 启用，用 getFresh 绕过 300s 进程缓存。
 */
@Injectable()
export class SelfopNegativeDeductConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SelfopNegativeDeductConfigService.name);
  private interval?: ReturnType<typeof setInterval>;
  private refreshing = false;

  constructor(private readonly systemConfig: SystemConfigService) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) return;
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** 立即从 DB 拉取并刷新 override（admin set 后调用即时生效；定时也调用）。防重入 + 不抛。 */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const raw = await this.systemConfig.getFresh(SELFOP_NEGATIVE_DEDUCT_CONFIG_KEY);
      setSelfopNegativeDeductOverride(coerceGateBool(raw));
    } catch (err) {
      this.logger.warn(
        `selfop-negative-deduct override refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.refreshing = false;
    }
  }
}
