type RedisScanner = {
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
};

export async function scanRedisKeys(
  redis: RedisScanner,
  pattern: string,
  count = 1000,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== '0');

  return keys;
}
