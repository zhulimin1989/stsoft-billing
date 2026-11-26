import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const prismaRoot = join(apiRoot, 'prisma');
const targetMigration =
  '20260715000100_personal_negative_balance_settlement';
const currentChecksum =
  'ead494351c7e71fd1d7e5b2d180f419abd044ed41f3ad6306c6598e9b13f75b9';
const oldChecksum =
  '0fbbce8db89f7ffe03b68c5a7e0b60375a22b246c335d32cdbae25588c3f1a7a';
const compatibilityBlock = `      -- PostgreSQL 18 stores table-column NOT NULL specifications in
      -- pg_constraint (contype = 'n').  Their truth is already covered by the
      -- column fingerprint above through pg_attribute.attnotnull.  Excluding
      -- them keeps this constraint fingerprint semantically identical across
      -- PostgreSQL 16-18 instead of counting the same invariant twice.
      AND constraint_row.contype <> 'n'
`;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parsePostgresUrl(rawValue, label) {
  const parsed = new URL(rawValue);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use postgresql://`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName || databaseName.includes('/')) {
    throw new Error(`${label} must identify exactly one database`);
  }
  return { parsed, databaseName };
}

function runPrisma(args, options = {}) {
  const capture = options.capture === true;
  const printableArgs = args.map((argument, index) =>
    index > 0 && args[index - 1] === '--url' ? '<redacted-url>' : argument,
  );
  const result = spawnSync('prisma', args, {
    cwd: apiRoot,
    env: {
      ...process.env,
      ...(options.databaseUrl
        ? { DATABASE_URL: options.databaseUrl }
        : undefined),
    },
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 10 * 1024 * 1024,
    stdio: capture ? 'pipe' : ['pipe', 'inherit', 'inherit'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`prisma terminated by signal ${result.signal}`);
  }
  if (options.expectFailure === true) {
    if (result.status === 0) {
      throw new Error(
        `prisma unexpectedly succeeded: ${printableArgs.join(' ')}`,
      );
    }
    return output;
  }
  if (result.status !== 0) {
    const tail = output.slice(-4000);
    throw new Error(
      `prisma failed with status ${result.status}: ${printableArgs.join(' ')}\n${tail}`,
    );
  }
  return output;
}

function executeSqlFile(databaseUrl, file) {
  runPrisma(['db', 'execute', '--file', file, '--url', databaseUrl]);
}

const adminDatabaseUrl = requiredEnvironment(
  'BILLING_PG18_ADMIN_DATABASE_URL',
);
const recoveryDatabaseUrl = requiredEnvironment(
  'BILLING_PG18_RECOVERY_DATABASE_URL',
);
const admin = parsePostgresUrl(adminDatabaseUrl, 'admin database URL');
const recovery = parsePostgresUrl(
  recoveryDatabaseUrl,
  'recovery database URL',
);

if (process.env.CI !== 'true') {
  throw new Error('PG18 recovery rehearsal may run only with CI=true');
}
if (admin.databaseName !== 'postgres') {
  throw new Error('admin database URL must target the postgres database');
}
if (recovery.databaseName !== 'billing_ledger_recovery_ci_pg18') {
  throw new Error(
    'recovery database must be named billing_ledger_recovery_ci_pg18',
  );
}
for (const key of ['hostname', 'port', 'username']) {
  if (admin.parsed[key] !== recovery.parsed[key]) {
    throw new Error(`admin and recovery database URL ${key} must match`);
  }
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(recovery.parsed.hostname)) {
  throw new Error('PG18 recovery rehearsal may connect only to localhost');
}

const currentSchema = join(prismaRoot, 'schema.prisma');
const currentMigration = join(
  prismaRoot,
  'migrations',
  targetMigration,
  'migration.sql',
);
const partialVerifier = join(
  prismaRoot,
  'recovery',
  targetMigration,
  'verify-pg18-partial.sql',
);
const recoveredVerifier = join(
  prismaRoot,
  'recovery',
  targetMigration,
  'verify-recovered.sql',
);
const currentSql = readFileSync(currentMigration, 'utf8');

if (checksum(currentSql) !== currentChecksum) {
  throw new Error('current ledger migration checksum changed unexpectedly');
}
const splitMigration = currentSql.split(compatibilityBlock);
if (splitMigration.length !== 2) {
  throw new Error(
    `expected one PostgreSQL 18 compatibility block, found ${splitMigration.length - 1}`,
  );
}
const oldSql = splitMigration.join('');
if (checksum(oldSql) !== oldChecksum) {
  throw new Error('reconstructed old ledger migration checksum is not exact');
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'billing-ledger-pg18-recovery-'));
try {
  const fixturePrismaRoot = join(temporaryRoot, 'prisma');
  cpSync(prismaRoot, fixturePrismaRoot, { recursive: true });
  const fixtureMigration = join(
    fixturePrismaRoot,
    'migrations',
    targetMigration,
    'migration.sql',
  );
  writeFileSync(fixtureMigration, oldSql);

  runPrisma(
    ['db', 'execute', '--stdin', '--url', adminDatabaseUrl],
    {
      input: `CREATE DATABASE "${recovery.databaseName}";\n`,
    },
  );

  runPrisma(
    ['migrate', 'deploy', '--schema', join(fixturePrismaRoot, 'schema.prisma')],
    {
      databaseUrl: recoveryDatabaseUrl,
      capture: true,
      expectFailure: true,
    },
  );

  const blockedReplay = runPrisma(
    ['migrate', 'deploy', '--schema', currentSchema],
    {
      databaseUrl: recoveryDatabaseUrl,
      capture: true,
      expectFailure: true,
    },
  );
  if (!blockedReplay.includes('P3009')) {
    throw new Error('unresolved old attempt did not fail closed with P3009');
  }

  executeSqlFile(recoveryDatabaseUrl, partialVerifier);

  runPrisma(
    [
      'migrate',
      'resolve',
      '--rolled-back',
      targetMigration,
      '--schema',
      currentSchema,
    ],
    { databaseUrl: recoveryDatabaseUrl },
  );
  runPrisma(['migrate', 'deploy', '--schema', currentSchema], {
    databaseUrl: recoveryDatabaseUrl,
  });

  executeSqlFile(recoveryDatabaseUrl, recoveredVerifier);
  console.log(
    `Verified PostgreSQL 18 recovery: ${oldChecksum} rolled back, ${currentChecksum} applied, phase EXPANDED`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
