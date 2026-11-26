import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { FinanceReportOverviewCacheService } from './finance-report-overview-cache.service';

function buildService(values: Record<string, string | undefined> = {}) {
  const config = {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const redis = {
    get: jest.fn(),
    set: jest.fn(async (key: string) => key.endsWith(':lock') ? 'OK' : 'OK'),
    del: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Pick<RedisService, 'get' | 'set' | 'del' | 'eval'>>;
  const service = new FinanceReportOverviewCacheService(
    config,
    redis as unknown as RedisService,
  );
  return { service, redis };
}

const scope = { month: '2026-09', billingMode: 'ALL' };

describe('FinanceReportOverviewCacheService', () => {
  it('returns a shared cache hit without recomputing', async () => {
    const { service, redis } = buildService();
    redis.get.mockResolvedValue(JSON.stringify({
      storedAtMs: Date.now(),
      value: { period: { month: '2026-09' } },
    }));
    const compute = jest.fn();

    await expect(service.getOrCompute(scope, compute)).resolves.toEqual({
      period: { month: '2026-09' },
    });
    expect(compute).not.toHaveBeenCalled();
  });

  it('stores only a successful computation with the configured hard TTL', async () => {
    const { service, redis } = buildService({
      FINANCE_REPORT_OVERVIEW_CACHE_TTL_SECONDS: '45',
    });
    redis.get.mockResolvedValue(null);

    const value = await service.getOrCompute(scope, async () => ({ ok: true }));

    expect(value).toEqual({ ok: true });
    const cacheWrite = redis.set.mock.calls.find(([key]) => !String(key).endsWith(':lock'));
    expect(cacheWrite).toEqual([
      'finance-report:overview:v1:2026-09:ALL',
      expect.any(String),
      'EX',
      45,
    ]);
    expect(JSON.parse(String(cacheWrite?.[1]))).toEqual({
      storedAtMs: expect.any(Number),
      value: { ok: true },
    });
  });

  it('coalesces concurrent computations in one process', async () => {
    const { service, redis } = buildService();
    redis.get.mockResolvedValue(null);
    let resolveCompute: ((value: { ok: boolean }) => void) | undefined;
    const compute = jest.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      resolveCompute = resolve;
    }));

    const first = service.getOrCompute(scope, compute);
    while (!resolveCompute) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const second = service.getOrCompute(scope, compute);
    resolveCompute?.({ ok: true });

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('forces refresh past an existing value and replaces it', async () => {
    const { service, redis } = buildService();
    redis.get.mockResolvedValue(JSON.stringify({
      storedAtMs: Date.now() - 1_000,
      value: { revision: 1 },
    }));

    await expect(service.getOrCompute(
      scope,
      async () => ({ revision: 2 }),
      { refresh: true },
    )).resolves.toEqual({ revision: 2 });

    const cacheWrite = redis.set.mock.calls.find(([key]) => !String(key).endsWith(':lock'));
    expect(JSON.parse(String(cacheWrite?.[1])).value).toEqual({ revision: 2 });
  });

  it('does not cache a failed computation', async () => {
    const { service, redis } = buildService();
    redis.get.mockResolvedValue(null);

    await expect(service.getOrCompute(scope, async () => {
      throw new Error('database timeout');
    })).rejects.toThrow('database timeout');

    expect(redis.set.mock.calls.filter(([key]) => !String(key).endsWith(':lock'))).toHaveLength(0);
  });
});
