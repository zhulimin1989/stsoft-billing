import {
  coerceGateBool,
  RollingQuotaGateConfigService,
  ROLLING_QUOTA_GATE_CONFIG_KEY,
} from './rolling-quota-gate-config.service';
import {
  rollingQuotaGateEnabled,
  rollingQuotaGateOverride,
  rollingQuotaGateEnvForced,
  setRollingQuotaGateOverride,
} from '../quota-templates/plan-quota-rule-views';

describe('coerceGateBool', () => {
  it('null/undefined/空串 => null（未配置=继承 env，不写 false）', () => {
    expect(coerceGateBool(null)).toBeNull();
    expect(coerceGateBool(undefined)).toBeNull();
    expect(coerceGateBool('')).toBeNull();
    expect(coerceGateBool('   ')).toBeNull();
  });
  it('显式真 => true', () => {
    for (const v of [true, 'true', 'TRUE', '1', 'on', 'yes', 1]) {
      expect(coerceGateBool(v)).toBe(true);
    }
  });
  it('显式假 => false', () => {
    for (const v of [false, 'false', '0', 'off', 'no', 0]) {
      expect(coerceGateBool(v)).toBe(false);
    }
  });
  it('未知值 => null', () => {
    expect(coerceGateBool('maybe')).toBeNull();
    expect(coerceGateBool(2)).toBeNull();
    expect(coerceGateBool({})).toBeNull();
  });
});

describe('rollingQuotaGateEnabled = env 强制 || admin override', () => {
  const ENV = 'BILLING_ROLLING_QUOTA_GATE_ENABLED';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
    setRollingQuotaGateOverride(null);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    setRollingQuotaGateOverride(null);
  });

  it('env 未设 + override null => 关', () => {
    expect(rollingQuotaGateEnabled()).toBe(false);
  });
  it('admin override true => 开（无需 GitOps）', () => {
    setRollingQuotaGateOverride(true);
    expect(rollingQuotaGateEnabled()).toBe(true);
  });
  it('admin override false + env 未设 => 关', () => {
    setRollingQuotaGateOverride(false);
    expect(rollingQuotaGateEnabled()).toBe(false);
  });
  it('env=true 强制开（admin override false 也关不掉，保护 prod）', () => {
    process.env[ENV] = 'true';
    setRollingQuotaGateOverride(false);
    expect(rollingQuotaGateEnvForced()).toBe(true);
    expect(rollingQuotaGateEnabled()).toBe(true);
  });
});

describe('RollingQuotaGateConfigService.refresh', () => {
  afterEach(() => setRollingQuotaGateOverride(null));

  it('从 SystemConfig.getFresh 读取并刷新 override', async () => {
    const systemConfig = { getFresh: jest.fn().mockResolvedValue(true) } as any;
    const svc = new RollingQuotaGateConfigService(systemConfig);
    await svc.refresh();
    expect(systemConfig.getFresh).toHaveBeenCalledWith(ROLLING_QUOTA_GATE_CONFIG_KEY);
    expect(rollingQuotaGateOverride()).toBe(true);
  });
  it('未配置(null) => override 置 null（继承 env）', async () => {
    const systemConfig = { getFresh: jest.fn().mockResolvedValue(null) } as any;
    await new RollingQuotaGateConfigService(systemConfig).refresh();
    expect(rollingQuotaGateOverride()).toBeNull();
  });
  it('getFresh 抛错时不抛、不改既有 override（容错）', async () => {
    setRollingQuotaGateOverride(true);
    const systemConfig = { getFresh: jest.fn().mockRejectedValue(new Error('db down')) } as any;
    await expect(new RollingQuotaGateConfigService(systemConfig).refresh()).resolves.toBeUndefined();
    expect(rollingQuotaGateOverride()).toBe(true);
  });
});
