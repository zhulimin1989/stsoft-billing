import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('GrowthEvent Prisma native-type contract', () => {
  it('keeps the Prisma id type aligned with the applied UUID migration', () => {
    const schema = readFileSync(
      resolve(__dirname, '../../prisma/schema.prisma'),
      'utf8',
    );
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260722000100_growth_events/migration.sql',
      ),
      'utf8',
    );
    const growthEventModel = schema.match(/model GrowthEvent \{([\s\S]*?)\n\}/)?.[1];
    const growthEventId = growthEventModel?.match(/^\s*id\s+String\b[^\n]*$/m)?.[0];

    expect(growthEventModel).toBeDefined();
    expect(growthEventId).toContain('@id');
    expect(growthEventId).toContain('@default(uuid())');
    expect(growthEventId).toContain('@db.Uuid');
    expect(migration).toMatch(/^\s*"id"\s+UUID\s+NOT NULL,\s*$/m);
  });
});
