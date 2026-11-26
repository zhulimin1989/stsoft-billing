import { scanRedisKeys } from './redis-scan.util';

describe('scanRedisKeys', () => {
  it('returns all keys across cursor pages', async () => {
    const redis = {
      scan: jest.fn()
        .mockResolvedValueOnce(['2', ['session:a']])
        .mockResolvedValueOnce(['0', ['session:b', 'session:c']]),
    };

    await expect(scanRedisKeys(redis, 'session:*')).resolves.toEqual([
      'session:a',
      'session:b',
      'session:c',
    ]);
    expect(redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', 'session:*', 'COUNT', 1000);
    expect(redis.scan).toHaveBeenNthCalledWith(2, '2', 'MATCH', 'session:*', 'COUNT', 1000);
  });

  it('uses the provided scan count', async () => {
    const redis = {
      scan: jest.fn().mockResolvedValue(['0', []]),
    };

    await scanRedisKeys(redis, 'bl:*', 250);

    expect(redis.scan).toHaveBeenCalledWith('0', 'MATCH', 'bl:*', 'COUNT', 250);
  });
});
