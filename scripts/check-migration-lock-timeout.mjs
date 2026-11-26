#!/usr/bin/env node
/**
 * 强制:任何取 ACCESS EXCLUSIVE / SHARE 级表锁的 DDL migration 必须自带 lock_timeout。
 *
 * 为什么(2026-09-01 两地 prod 发版实际事故):
 *   codesphere-user 的 20260818071058 只有一句裸 `ALTER TABLE "users" ADD COLUMN ... TEXT`,
 *   没有 lock_timeout。它被两个持 AccessShareLock 的空闲事务挡住,等了 12 分钟。
 *   ACCESS EXCLUSIVE 一旦排到锁队列队首,**后续所有对该表的新查询都会排在它后面**
 *   —— users 是登录路径的核心表,当时只因凌晨无请求才没扩散成故障。
 *   有 lock_timeout 时:拿不到锁就快速失败,migrate 报错回滚,锁队列立刻清空,重跑即可。
 *
 * 历史 migration 不可修改(Prisma 会校验 migration.sql 的 checksum,改了 migrate deploy 直接报错),
 * 因此已存在的违规记录在 baseline 里作为历史豁免;**新增 migration 必须合规**。
 * baseline 只允许变小:删掉某条(补了 lock_timeout)可以,往里加新条目会被本脚本拒绝。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const MIGRATION_DIRS = [
  'apps/api/prisma/migrations',
  'apps/api/prisma/admin/migrations',
  'prisma/migrations',
];
const BASELINE = 'scripts/migration-lock-timeout.baseline.json';

/**
 * 取强表锁、必须有 lock_timeout 的语句。
 * 说明:
 *  - CREATE TABLE / CREATE FUNCTION / COMMENT / DML(INSERT/UPDATE/DELETE) 不在此列
 *    —— 它们不取 ACCESS EXCLUSIVE(新表没有并发访问者;DML 取 ROW EXCLUSIVE 不阻塞读)。
 *  - 带 CONCURRENTLY 的索引操作豁免:它取 SHARE UPDATE EXCLUSIVE(不阻塞读写),
 *    且**不能在事务块内执行**,因而无法用 SET LOCAL。
 */
const LOCKING_RULES = [
  { name: 'ALTER TABLE', regex: /^\s*ALTER\s+TABLE\b/im },
  { name: 'DROP TABLE', regex: /^\s*DROP\s+TABLE\b/im },
  { name: 'TRUNCATE', regex: /^\s*TRUNCATE\b/im },
  { name: 'CREATE TRIGGER', regex: /^\s*CREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/im },
  { name: 'DROP TRIGGER', regex: /^\s*DROP\s+TRIGGER\b/im },
  { name: 'CREATE INDEX (非 CONCURRENTLY)', regex: /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/im },
  { name: 'DROP INDEX (非 CONCURRENTLY)', regex: /^\s*DROP\s+INDEX\s+(?!CONCURRENTLY\b)/im },
  { name: 'ALTER SEQUENCE OWNED BY', regex: /^\s*ALTER\s+SEQUENCE\b.*\bOWNED\s+BY\b/im },
];

const HAS_LOCK_TIMEOUT = /^\s*SET\s+(LOCAL\s+)?lock_timeout\s*=/im;

/** 去掉行注释和块注释,避免注释里的 "ALTER TABLE" 被误判 */
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

function findMigrationFiles() {
  const out = [];
  for (const dir of MIGRATION_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs).sort()) {
      const sql = path.join(abs, name, 'migration.sql');
      if (fs.existsSync(sql)) out.push({ id: name, rel: path.relative(root, sql) });
    }
  }
  return out;
}

function loadBaseline() {
  const abs = path.join(root, BASELINE);
  if (!fs.existsSync(abs)) return { exempt: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return { exempt: Array.isArray(parsed.exempt) ? parsed.exempt : [] };
  } catch (err) {
    console.error(`${BASELINE} 无法解析: ${err.message}`);
    process.exit(1);
  }
}

const writeMode = process.argv.includes('--write-baseline');
const files = findMigrationFiles();
const baseline = loadBaseline();
const exempt = new Set(baseline.exempt);

const violations = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(root, f.rel), 'utf8');
  const sql = stripComments(raw);
  if (HAS_LOCK_TIMEOUT.test(sql)) continue;
  const hit = LOCKING_RULES.filter((r) => r.regex.test(sql)).map((r) => r.name);
  if (hit.length > 0) violations.push({ ...f, statements: hit });
}

if (writeMode) {
  const ids = violations.map((v) => v.id).sort();
  fs.writeFileSync(
    path.join(root, BASELINE),
    `${JSON.stringify(
      {
        _comment:
          '取强表锁的 DDL 却没有 lock_timeout 的历史 migration。已应用的 migration 不可改(Prisma 校验 checksum),故在此豁免。本清单只允许变小 —— 新增 migration 必须自带 lock_timeout。',
        exempt: ids,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`baseline 已写入 ${ids.length} 条豁免。`);
  process.exit(0);
}

const fresh = violations.filter((v) => !exempt.has(v.id));
const stale = [...exempt].filter((id) => !violations.some((v) => v.id === id));

if (fresh.length > 0) {
  console.error(
    'migration lock_timeout 检查失败:下列 migration 含取强表锁的 DDL 却没有 lock_timeout。',
  );
  console.error(
    '裸 DDL 拿不到锁时会无限等待,并把 ACCESS EXCLUSIVE 顶在锁队列队首 ——',
  );
  console.error(
    '该表后续所有新查询都会排在它后面(2026-09-01 两地 prod 发版实际发生过,users 表被堵 12 分钟)。',
  );
  for (const v of fresh) {
    console.error(`- ${v.rel}  [${v.statements.join(', ')}]`);
  }
  console.error('');
  console.error('修法:在 migration.sql 顶部加');
  console.error('    BEGIN;');
  console.error("    SET LOCAL lock_timeout = '5s';");
  console.error('    ...你的 DDL...');
  console.error('    COMMIT;');
  console.error('CREATE/DROP INDEX CONCURRENTLY 不能放进事务,本检查已自动豁免。');
  process.exit(1);
}

if (stale.length > 0) {
  console.error('migration lock_timeout baseline 有过期条目(已补 lock_timeout 或文件不存在):');
  for (const id of stale) console.error(`- ${id}`);
  console.error(`请从 ${BASELINE} 移除,或运行:pnpm migration:lock-timeout:baseline`);
  process.exit(1);
}

console.log(
  `migration lock_timeout 检查通过(${files.length} 个 migration,${exempt.size} 条历史豁免)。`,
);
