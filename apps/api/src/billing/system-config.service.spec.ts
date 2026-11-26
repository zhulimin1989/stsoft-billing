import { Test } from '@nestjs/testing';
import { SystemConfigService } from './system-config.service';
import { PrismaService } from '../prisma/prisma.service';

function makePrisma() {
  return {
    systemConfig: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
  };
}

async function buildService(prismaOverrides = {}) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const m = await Test.createTestingModule({
    providers: [
      SystemConfigService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return { service: m.get(SystemConfigService) as SystemConfigService, prisma };
}

// ============================================================
// SystemConfigService.get / getAll — cache logic
// ============================================================
describe('SystemConfigService.get', () => {
  it('returns value from DB after loading cache', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'maxTokens', value: '1000' },
    ]);

    const result = await service.get('maxTokens');
    expect(result).toBe(1000);
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns defaultValue when key not found', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);

    const result = await service.get('missing', 42);
    expect(result).toBe(42);
  });

  it('returns undefined when key not found and no default', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);

    const result = await service.get('missing');
    expect(result).toBeUndefined();
  });

  it('parses JSON string values correctly', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'features', value: '["a","b","c"]' },
    ]);

    const result = await service.get('features');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('parses JSON object values correctly', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'config', value: '{"rate":5,"enabled":true}' },
    ]);

    const result = await service.get('config');
    expect(result).toEqual({ rate: 5, enabled: true });
  });

  it('parses JSON boolean true', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'enabled', value: 'true' },
    ]);

    const result = await service.get('enabled');
    expect(result).toBe(true);
  });

  it('returns raw string when JSON.parse fails', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'raw', value: 'not-valid-json' },
    ]);

    const result = await service.get('raw');
    expect(result).toBe('not-valid-json');
  });

  it('uses cache on second call (no second DB query)', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'k', value: '"hello"' },
    ]);

    await service.get('k');
    await service.get('k');

    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
  });

  it('re-fetches DB after invalidateCache is called', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany
      .mockResolvedValueOnce([{ key: 'k', value: '"v1"' }])
      .mockResolvedValueOnce([{ key: 'k', value: '"v2"' }]);

    const r1 = await service.get('k');
    service.invalidateCache();
    const r2 = await service.get('k');

    expect(r1).toBe('v1');
    expect(r2).toBe('v2');
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(2);
  });

  // Regression: empty system_config table used to hammer DB on every call
  // because `Object.keys(cache).length === 0` tripped the cache-miss check.
  it('caches empty DB result (no re-query within TTL)', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);

    await service.get('anything');
    await service.get('anything');
    await service.getNumber('n', 5);
    await service.getAll();

    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
  });

  it('caches empty result across mixed read methods', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);

    const r1 = await service.get('k', 'default');
    const r2 = await service.getAll();
    const r3 = await service.getNumber('n', 9);

    expect(r1).toBe('default');
    expect(r2).toEqual({});
    expect(r3).toBe(9);
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// SystemConfigService.getNumber
// ============================================================
describe('SystemConfigService.getNumber', () => {
  it('returns numeric value from config', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'rateLimit', value: '60' },
    ]);

    const result = await service.getNumber('rateLimit', 10);
    expect(result).toBe(60);
  });

  it('returns defaultValue when key is missing', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);

    const result = await service.getNumber('missing', 99);
    expect(result).toBe(99);
  });

  it('returns defaultValue when stored value is not a number (string)', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'nonNumeric', value: '"hello"' },
    ]);

    const result = await service.getNumber('nonNumeric', 5);
    expect(result).toBe(5);
  });

  it('returns defaultValue when stored value is boolean', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'flag', value: 'true' },
    ]);

    const result = await service.getNumber('flag', 0);
    expect(result).toBe(0);
  });
});

// ============================================================
// SystemConfigService.getAll
// ============================================================
describe('SystemConfigService.getAll', () => {
  it('returns all config keys as record', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'a', value: '1' },
      { key: 'b', value: '"hello"' },
    ]);

    const result = await service.getAll();
    expect(result).toEqual({ a: 1, b: 'hello' });
  });

  it('returns empty record when no config rows', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);

    const result = await service.getAll();
    expect(result).toEqual({});
  });

  it('returns a copy of cache (mutation does not affect service)', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([
      { key: 'x', value: '42' },
    ]);

    const r1 = await service.getAll();
    r1['x'] = 'mutated';

    const r2 = await service.getAll();
    expect(r2['x']).toBe(42); // original unchanged
  });
});

// ============================================================
// SystemConfigService.set
// ============================================================
describe('SystemConfigService.set', () => {
  it.each(['deploymentConfig', 'authConfig', 'platformConfig'])(
    'rejects direct writes to security-critical key %s',
    async (key) => {
      const { service, prisma } = await buildService();
      await expect(service.set(key, {})).rejects.toThrow(
        '只能通过版本化 deploymentConfig 快照修改',
      );
      expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
    },
  );

  it('upserts key-value into DB with JSON-stringified value', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);
    prisma.systemConfig.upsert.mockResolvedValue({ key: 'k', value: '42' });

    await service.set('k', 42);

    expect(prisma.systemConfig.upsert).toHaveBeenCalledWith({
      where: { key: 'k' },
      update: { value: '42' },
      create: { key: 'k', value: '42' },
    });
  });

  it('stores string value as JSON string', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);
    prisma.systemConfig.upsert.mockResolvedValue({ key: 'name', value: '"Alice"' });

    await service.set('name', 'Alice');

    expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { value: '"Alice"' },
        create: { key: 'name', value: '"Alice"' },
      }),
    );
  });

  it('stores array value as JSON array string', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);
    prisma.systemConfig.upsert.mockResolvedValue({ key: 'tags', value: '["a","b"]' });

    await service.set('tags', ['a', 'b']);

    expect(prisma.systemConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { value: '["a","b"]' },
      }),
    );
  });

  it('updates in-memory cache after set', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany.mockResolvedValue([]);
    prisma.systemConfig.upsert.mockResolvedValue({ key: 'k', value: '"new"' });

    // Populate cache first
    await service.getAll();

    await service.set('k', 'new');

    // Should not call findMany again — cache is warm after set
    prisma.systemConfig.findMany.mockClear();
    const result = await service.get('k');
    expect(result).toBe('new');
    expect(prisma.systemConfig.findMany).not.toHaveBeenCalled();
  });
});

// ============================================================
// SystemConfigService.invalidateCache
// ============================================================
describe('SystemConfigService.invalidateCache', () => {
  it('forces re-fetch from DB on next get call', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findMany
      .mockResolvedValueOnce([{ key: 'v', value: '1' }])
      .mockResolvedValueOnce([{ key: 'v', value: '2' }]);

    await service.get('v');
    service.invalidateCache();
    const result = await service.get('v');

    expect(result).toBe(2);
    expect(prisma.systemConfig.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('SystemConfigService deployment snapshots', () => {
  const stored = {
    id: 'deployment-config',
    key: 'deploymentConfig',
    version: 6n,
    value: JSON.stringify({
      region: 'domestic',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    }),
  };

  it('bypasses process cache and derives provider from region', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findUnique.mockResolvedValue(stored);

    await expect(service.getDeploymentConfig()).resolves.toEqual({
      version: '6',
      region: 'domestic',
      provider: 'authing',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    });
    await service.getDeploymentConfig();
    expect(prisma.systemConfig.findUnique).toHaveBeenCalledTimes(2);
  });

  it('uses an explicit transaction client for every deployment-config read', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.findUnique.mockRejectedValue(
      new Error('root system-config client leaked into finance snapshot'),
    );
    const tx = {
      systemConfig: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { key: string } }) => {
          if (where.key === 'deploymentConfig') return null;
          if (where.key === 'platformConfig') {
            return {
              key: 'platformConfig',
              value: JSON.stringify({ region: 'domestic', currency: 'cny' }),
            };
          }
          return null;
        }),
      },
    };

    await expect(service.getDeploymentConfig(tx as any)).resolves.toEqual({
      version: '0',
      region: 'domestic',
      provider: 'authing',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    });

    expect(tx.systemConfig.findUnique).toHaveBeenCalledTimes(3);
    expect(prisma.systemConfig.findUnique).not.toHaveBeenCalled();
  });

  it('applies only a newer version', async () => {
    const { service, prisma } = await buildService();
    prisma.systemConfig.updateMany.mockResolvedValue({ count: 1 });
    prisma.systemConfig.findUnique.mockResolvedValue(stored);

    await service.applyDeploymentConfig({
      version: '6',
      region: 'domestic',
      provider: 'authing',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    });

    expect(prisma.systemConfig.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'deploymentConfig', version: { lt: 6n } },
    }));
  });

  it('rejects mismatched provider and region', async () => {
    const { service, prisma } = await buildService();
    await expect(service.applyDeploymentConfig({
      version: '7',
      region: 'domestic',
      provider: 'auth0',
      currency: 'cny',
      oauth: {},
    })).rejects.toThrow('provider 必须由 region 派生为 authing');
    expect(prisma.systemConfig.updateMany).not.toHaveBeenCalled();
  });
});
