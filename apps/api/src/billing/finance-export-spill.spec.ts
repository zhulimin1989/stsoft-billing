import { readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FinanceExportDiskCache,
  FinanceExportExternalSorter,
} from './finance-export-spill';

describe('finance export spill utilities', () => {
  it('sorts multiple disk runs while preserving the order of equal rows', async () => {
    const prefix = join(tmpdir(), 'finance-sort-test-');
    const sorter = new FinanceExportExternalSorter<{ key: number; value: string }>(
      prefix,
      (left, right) => left.key - right.key,
      { bufferRows: 2, mergeFanIn: 2 },
    );
    try {
      await sorter.add([
        { key: 2, value: 'second-a' },
        { key: 1, value: 'first' },
        { key: 2, value: 'second-b' },
        { key: 3, value: 'third' },
      ]);
      const rows = [] as Array<{ key: number; value: string }>;
      for await (const batch of sorter.batches(1)) rows.push(...batch);
      expect(rows).toEqual([
        { key: 1, value: 'first' },
        { key: 2, value: 'second-a' },
        { key: 2, value: 'second-b' },
        { key: 3, value: 'third' },
      ]);
    } finally {
      await sorter.dispose();
    }
  });

  it('folds equal keys across independent disk runs', async () => {
    const sorter = new FinanceExportExternalSorter<{ key: string; total: number }>(
      join(tmpdir(), 'finance-fold-test-'),
      (left, right) => left.key.localeCompare(right.key),
      {
        bufferRows: 1,
        mergeFanIn: 2,
        mergeEqual: (left, right) => ({ key: left.key, total: left.total + right.total }),
      },
    );
    try {
      await sorter.add([
        { key: 'b', total: 2 },
        { key: 'a', total: 1 },
        { key: 'b', total: 3 },
      ]);
      const rows = [] as Array<{ key: string; total: number }>;
      for await (const batch of sorter.batches(10)) rows.push(...batch);
      expect(rows).toEqual([
        { key: 'a', total: 1 },
        { key: 'b', total: 5 },
      ]);
    } finally {
      await sorter.dispose();
    }
  });

  it('retrieves evicted values and null sentinels from the disk cache', async () => {
    const prefix = join(tmpdir(), 'finance-cache-test-');
    const cache = new FinanceExportDiskCache<{ phone: string }>(prefix, 1, 2);
    try {
      await cache.setMany(new Map([
        ['user-a', { phone: '13000000000' }],
        ['user-b', null],
      ]));
      const values = await cache.getMany(['user-a', 'user-b', 'missing']);
      expect(values.get('user-a')).toEqual({ phone: '13000000000' });
      expect(values.has('user-b')).toBe(true);
      expect(values.get('user-b')).toBeNull();
      expect(values.has('missing')).toBe(false);
    } finally {
      await cache.dispose();
    }
    const leftovers = (await readdir(tmpdir())).filter((name) => (
      name.startsWith('finance-cache-test-')
    ));
    expect(leftovers).toEqual([]);
  });
});
