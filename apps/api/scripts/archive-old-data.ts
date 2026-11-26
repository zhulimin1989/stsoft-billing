/**
 * 数据归档脚本 — 清理超过保留期的无界增长表数据
 *
 * 用法:
 *   npx ts-node scripts/archive-old-data.ts --dry-run    # 预览将删除的数据量
 *   npx ts-node scripts/archive-old-data.ts              # 实际执行
 *
 * 环境变量:
 *   DATABASE_URL — PostgreSQL 连接字符串
 *   ARCHIVE_TOKEN_USAGE_DAYS — token_usage 保留天数（默认 90）
 *   ARCHIVE_AUDIT_LOG_DAYS — audit_logs 保留天数（默认 365）
 *   ARCHIVE_TRANSACTION_DAYS — balance_transactions 保留天数（默认 365）
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const isDryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 1000;

interface ArchiveTarget {
  name: string;
  retentionDays: number;
  countFn: (before: Date) => Promise<number>;
  deleteFn: (before: Date, limit: number) => Promise<number>;
}

const targets: ArchiveTarget[] = [
  {
    name: 'token_usage',
    retentionDays: parseInt(process.env.ARCHIVE_TOKEN_USAGE_DAYS || '90'),
    countFn: (before) => prisma.tokenUsage.count({ where: { createdAt: { lt: before } } }),
    deleteFn: async (before, limit) => {
      const old = await prisma.tokenUsage.findMany({
        where: { createdAt: { lt: before } },
        select: { id: true },
        take: limit,
      });
      if (old.length === 0) return 0;
      const result = await prisma.tokenUsage.deleteMany({
        where: { id: { in: old.map((r) => r.id) } },
      });
      return result.count;
    },
  },
  {
    name: 'audit_logs',
    retentionDays: parseInt(process.env.ARCHIVE_AUDIT_LOG_DAYS || '365'),
    countFn: (before) => prisma.auditLog.count({ where: { createdAt: { lt: before } } }),
    deleteFn: async (before, limit) => {
      const old = await prisma.auditLog.findMany({
        where: { createdAt: { lt: before } },
        select: { id: true },
        take: limit,
      });
      if (old.length === 0) return 0;
      const result = await prisma.auditLog.deleteMany({
        where: { id: { in: old.map((r) => r.id) } },
      });
      return result.count;
    },
  },
];

async function main() {
  console.log(isDryRun ? '=== DRY RUN ===' : '=== EXECUTING ===');

  for (const target of targets) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - target.retentionDays);
    const count = await target.countFn(cutoff);
    console.log(`[${target.name}] ${count} rows older than ${target.retentionDays} days (before ${cutoff.toISOString()})`);

    if (!isDryRun && count > 0) {
      let deleted = 0;
      while (deleted < count) {
        const batch = await target.deleteFn(cutoff, BATCH_SIZE);
        if (batch === 0) break;
        deleted += batch;
        console.log(`  deleted ${deleted}/${count}`);
      }
      console.log(`  total deleted: ${deleted}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Archive failed:', err);
  process.exit(1);
});
