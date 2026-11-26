#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scanRoots = ['apps/api/src', 'apps/api/prisma'];
const allowList = new Set([
  'apps/api/src/prisma/prisma.service.ts',
  'apps/api/src/common/utils/assert-production-secrets.ts',
]);
const patternAllowList = new Map([
  [
    'apps/api/prisma/seed.ts',
    new Set(['manual PrismaClient construction']),
  ],
]);
const productionEnvFiles = ['.env.production.example'];
const forbiddenProductionEnvKeys = new Set([
  'DATABASE_URL',
  'ADMIN_DATABASE_URL',
  'USER_DATABASE_URL',
]);

const ignoredSegments = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
]);

const patterns = [
  {
    name: 'manual PrismaClient construction',
    regex: /\bnew\s+PrismaClient\s*\(/,
  },
  {
    name: 'manual Prisma datasource override',
    regex: /\bdatasources\s*:\s*\{/,
  },
  {
    name: 'direct split database URL access',
    regex: /\b(BILLING_DATABASE_URL|ADMIN_DATABASE_URL|USER_DATABASE_URL)\b/,
  },
];

const runtimeBoundaryChecks = [
  {
    file: 'Dockerfile',
    required: [
      {
        name: 'billing Docker entrypoint',
        regex: /CMD\s+\[\s*"node"\s*,\s*"dist\/billing-main\.js"\s*\]/,
      },
    ],
    forbidden: [
      {
        name: 'legacy full AppModule Docker entrypoint',
        regex: /dist\/main\.js/,
      },
    ],
  },
  {
    file: 'apps/api/src/billing-main.ts',
    required: [
      {
        name: 'billing runtime module entry',
        regex: /import\s+\{\s*BillingRuntimeModule\s*\}\s+from\s+['"]\.\/billing-runtime\/billing-runtime\.module['"]/,
      },
      {
        name: 'billing service identity',
        regex: /process\.env\.RUIDONG_SERVICE\s*=\s*['"]billing['"]/,
      },
    ],
    forbidden: [
      {
        name: 'full AppModule in billing-main',
        regex: /from\s+['"]\.\/app\.module['"]/,
      },
    ],
  },
  {
    file: 'apps/api/src/billing-runtime/billing-runtime.module.ts',
    required: [
      {
        name: 'billing runtime module',
        regex: /export\s+class\s+BillingRuntimeModule/,
      },
    ],
    forbidden: [
      {
        name: 'billing runtime importing legacy AuthModule',
        regex: /\bAuthModule\b|from\s+['"][^'"]*\/auth\/auth\.module['"]/,
      },
      {
        name: 'billing runtime importing legacy UserModule',
        regex: /\bUserModule\b|from\s+['"][^'"]*\/user\/user\.module['"]/,
      },
      {
        name: 'billing runtime importing legacy AppModule',
        regex: /\bAppModule\b|from\s+['"][^'"]*\/app\.module['"]/,
      },
    ],
  },
];

const forbiddenRuntimeFiles = [
  {
    file: 'apps/api/src/main.ts',
    name: 'legacy full AppModule entrypoint',
  },
  {
    file: 'apps/api/src/app.module.ts',
    name: 'legacy full AppModule',
  },
  {
    file: 'apps/api/src/admin-main.ts',
    name: 'legacy admin entrypoint',
  },
];

const billingRuntimeIdentityMirrorFiles = [
  'apps/api/src/billing-runtime/billing-auth.guard.ts',
  'apps/api/src/billing-runtime/billing-workspace-mirror.service.ts',
  'apps/api/src/billing-runtime/saas-provisioning.service.ts',
  'apps/api/src/billing-runtime/billing-admin.controller.ts',
];

const forbiddenMigrationTablesAfterRuntimeSplit = [
  'admin_roles',
  'admin_members',
  'admin_activity_logs',
];
const migrationBoundaryCutoff = '20260610001100_user_snapshot_drop_auth_fields';

function forbiddenAdminTableExpansionPatterns(tableName) {
  const quoted = `["']?${tableName}["']?`;
  return [
    {
      name: 'create legacy admin table after runtime split',
      regex: new RegExp(`\\bCREATE\\s+TABLE\\b[^;]*${quoted}`, 'i'),
    },
    {
      name: 'add columns to legacy admin table after runtime split',
      regex: new RegExp(`\\bALTER\\s+TABLE\\s+${quoted}\\s+ADD\\b`, 'i'),
    },
    {
      name: 'create index on legacy admin table after runtime split',
      regex: new RegExp(`\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\b[^;]*\\bON\\s+${quoted}`, 'i'),
    },
  ];
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && fullPath.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function isPatternAllowed(file, patternName) {
  return allowList.has(file) || patternAllowList.get(file)?.has(patternName);
}

const violations = [];

for (const scanRoot of scanRoots) {
  for (const file of walk(path.join(root, scanRoot))) {
    const rel = relative(file);
    if (rel.endsWith('.spec.ts')) continue;

    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    for (const pattern of patterns) {
      if (isPatternAllowed(rel, pattern.name)) continue;
      for (const match of source.matchAll(new RegExp(pattern.regex, 'g'))) {
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        violations.push({
          file: rel,
          line,
          pattern: pattern.name,
          text: lines[line - 1]?.trim() ?? '',
        });
      }
    }
  }
}

for (const envFile of productionEnvFiles) {
  const fullPath = path.join(root, envFile);
  if (!fs.existsSync(fullPath)) continue;
  const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (match && forbiddenProductionEnvKeys.has(match[1])) {
      violations.push({
        file: envFile,
        line: index + 1,
        pattern: 'forbidden production env key',
        text: line.trim(),
      });
    }
  });
}

for (const check of runtimeBoundaryChecks) {
  const fullPath = path.join(root, check.file);
  if (!fs.existsSync(fullPath)) {
    violations.push({
      file: check.file,
      line: 1,
      pattern: 'runtime ownership boundary',
      text: 'required runtime file is missing',
    });
    continue;
  }
  const source = fs.readFileSync(fullPath, 'utf8');
  const lines = source.split(/\r?\n/);
  for (const rule of check.required) {
    if (!rule.regex.test(source)) {
      violations.push({
        file: check.file,
        line: 1,
        pattern: `missing ${rule.name}`,
        text: 'billing-api must boot BillingRuntimeModule from billing-main',
      });
    }
  }
  for (const rule of check.forbidden) {
    const match = source.match(rule.regex);
    if (!match) continue;
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    violations.push({
      file: check.file,
      line,
      pattern: rule.name,
      text: lines[line - 1]?.trim() ?? '',
    });
  }
}

for (const item of forbiddenRuntimeFiles) {
  const fullPath = path.join(root, item.file);
  if (!fs.existsSync(fullPath)) continue;
  violations.push({
    file: item.file,
    line: 1,
    pattern: 'runtime ownership boundary',
    text: `${item.name} must not exist in billing runtime package`,
  });
}

for (const file of billingRuntimeIdentityMirrorFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    violations.push({
      file,
      line: 1,
      pattern: 'runtime identity mirror boundary',
      text: 'required billing-runtime identity mirror file is missing',
    });
    continue;
  }

  const source = fs.readFileSync(fullPath, 'utf8');
  const lines = source.split(/\r?\n/);
  const forbiddenIdentityMirrorWrites = [
    {
      name: 'billing runtime user password write',
      regex: /\bpassword\s*:/g,
    },
    {
      name: 'billing runtime user auth role write',
      regex: /\brole\s*:\s*['"]USER['"]/g,
    },
  ];

  for (const rule of forbiddenIdentityMirrorWrites) {
    for (const match of source.matchAll(rule.regex)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      violations.push({
        file,
        line,
        pattern: rule.name,
        text: lines[line - 1]?.trim() ?? '',
      });
    }
  }
}

const migrationsDir = path.join(root, 'apps/api/prisma/migrations');
if (fs.existsSync(migrationsDir)) {
  for (const entry of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name <= migrationBoundaryCutoff) continue;
    const migrationPath = path.join(migrationsDir, entry.name, 'migration.sql');
    if (!fs.existsSync(migrationPath)) continue;
    const source = fs.readFileSync(migrationPath, 'utf8');
    const lines = source.split(/\r?\n/);
    for (const tableName of forbiddenMigrationTablesAfterRuntimeSplit) {
      for (const rule of forbiddenAdminTableExpansionPatterns(tableName)) {
        const match = source.match(rule.regex);
        if (!match) continue;
        const line = source.slice(0, match.index).split(/\r?\n/).length;
        violations.push({
          file: relative(migrationPath),
          line,
          pattern: rule.name,
          text: lines[line - 1]?.trim() ?? '',
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('DB boundary check failed. Use the owning service API instead of cross-DB Prisma access.');
  for (const item of violations) {
    console.error(`- ${item.file}:${item.line} ${item.pattern}: ${item.text}`);
  }
  process.exit(1);
}

console.log('DB boundary check passed.');
