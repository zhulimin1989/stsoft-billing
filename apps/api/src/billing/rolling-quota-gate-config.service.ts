import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SystemConfigService } from './system-config.service';
import { setRollingQuotaGateOverride } from '../quota-templates/plan-quota-rule-views';
import { isBillingRuntime } from '../common/runtime/service-role';

/** SystemConfig key：滚动配额 gate 的运行时 admin 开关（DB 支撑，无需改 GitOps env）。 */
export const ROLLING_QUOTA_GATE_CONFIG_KEY = 'rolling_quota_gate_enabled';

const REFRESH_INTERVAL_MS = 30_000;

/**
 * 把 SystemConfig['rolling_quota_gate_enabled'] 解析为 true/false/null。
 * null/undefined/'' → null（未配置=继承 env，不写 false）；显式真/假 → 对应布尔；其它 → null。
 */
export function coerceGateBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 0 ? false : value === 1 ? true : null;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === '') return null;
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return null;
  }
  return null;
}

/**
 * 定时（+即时）把滚动配额 gate 的 admin 运行时开关（SystemConfig）刷新到 plan-quota-rule-views 的
 * 模块级 override，使同步的 rollingQuotaGateEnabled() 在多副本下也能在 ~30s 内看到 admin 改动。
 * 仅 billing runtime 启用。用 getFresh 绕过 SystemConfig 300s 进程缓存（否则其余 Pod 最长 300s 才生效）。
 */
@Injectable()
export class RollingQuotaGateConfigService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RollingQuotaGateConfigService.name);
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
      const raw = await this.systemConfig.getFresh(ROLLING_QUOTA_GATE_CONFIG_KEY);
      setRollingQuotaGateOverride(coerceGateBool(raw));
    } catch (err) {
      this.logger.warn(
        `rolling-quota gate override refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.refreshing = false;
    }
  }
}
