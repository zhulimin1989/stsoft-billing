import { RollingQuotaGateSchedulerService } from './rolling-quota-gate-scheduler.service';

const GATE_ENV = 'BILLING_ROLLING_QUOTA_GATE_ENABLED';

function make(networkDisabled = false) {
  const redis = {
    zrangebyscore: jest.fn().mockResolvedValue([]),
    zrange: jest.fn().mockResolvedValue([]),
    zrem: jest.fn().mockResolvedValue(1),
  };
  const publisherSync = {
    syncKeyBalanceById: jest.fn().mockResolvedValue(undefined),
  };
  const publisher = {
    isNetworkDisabled: jest.fn().mockReturnValue(networkDisabled),
  };
  const service = new RollingQuotaGateSchedulerService(
    redis as never,
    publisherSync as never,
    publisher as never,
  );
  return { service, redis, publisherSync, publisher };
}

describe('RollingQuotaGateSchedulerService', () => {
  let prevGate: string | undefined;
  let prevRole: string | undefined;
  beforeEach(() => {
    prevGate = process.env[GATE_ENV];
    prevRole = process.env.RUIDONG_SERVICE;
  });
  afterEach(() => {
    if (prevGate === undefined) delete process.env[GATE_ENV];
    else process.env[GATE_ENV] = prevGate;
    if (prevRole === undefined) delete process.env.RUIDONG_SERVICE;
    else process.env.RUIDONG_SERVICE = prevRole;
    jest.useRealTimers();
  });

  it('does not start timers or touch Redis while Publisher network is disabled', async () => {
    jest.useFakeTimers();
    process.env.RUIDONG_SERVICE = 'billing';
    const { service, redis, publisherSync } = make(true);

    service.onModuleInit();
    await service.tick();

    expect(jest.getTimerCount()).toBe(0);
    expect(redis.zrangebyscore).not.toHaveBeenCalled();
    expect(redis.zrange).not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceById).not.toHaveBeenCalled();
  });

  it('rechecks due keys by score when the gate is on (sync handles ZREM)', async () => {
    process.env[GATE_ENV] = 'true';
    const { service, redis, publisherSync } = make();
    redis.zrangebyscore.mockResolvedValue(['k1', 'k2']);

    await service.tick();

    expect(redis.zrangebyscore).toHaveBeenCalled();
    expect(redis.zrange).not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceById).toHaveBeenCalledWith('k1', { deleteWhenMissing: false });
    expect(publisherSync.syncKeyBalanceById).toHaveBeenCalledWith('k2', { deleteWhenMissing: false });
    // 开关开时不主动 ZREM（由 sync 内部按配额恢复情况处理）
    expect(redis.zrem).not.toHaveBeenCalled();
  });

  it('drains the whole gated set and restores balances when the gate is off (rollback)', async () => {
    delete process.env[GATE_ENV];
    const { service, redis, publisherSync } = make();
    redis.zrange.mockResolvedValue(['k1']);

    await service.tick();

    expect(redis.zrange).toHaveBeenCalled();
    expect(redis.zrangebyscore).not.toHaveBeenCalled();
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'k1');
    expect(publisherSync.syncKeyBalanceById).toHaveBeenCalledWith('k1', { deleteWhenMissing: false });
  });

  it('does nothing when the gated set is empty', async () => {
    process.env[GATE_ENV] = 'true';
    const { service, publisherSync } = make();

    await service.tick();

    expect(publisherSync.syncKeyBalanceById).not.toHaveBeenCalled();
  });
});
