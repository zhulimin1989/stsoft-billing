/**
 * TokenPlan 0729「积分量级 ×50」存量余额迁移 CLI（P0 止血；逻辑在
 * src/billing/tokenplan-0729-x50-migration.ts，本文件只做引导/参数/journal/resync）。
 *
 * 运行（生产走变更窗口，先 dry-run 后 execute）：
 *   BILLING_DATABASE_URL=... REDIS_HOST=... pnpm --filter api tokenplan:migrate-0729-x50 -- [flags]
 *
 * flags：
 *   --execute                 真正写库（缺省 dry-run 只出报告）
 *   --include-bonus           bonus 池补偿（必须配 --cutoff）
 *   --cutoff <ISO时刻>        0729 后台配置切换时刻（必须带时区，如 2026-07-29T18:00:00+08:00）
 *   --include-grant           grant 池 GrantRedemption ×50（见下方硬性前置）
 *   --grant-traffic-paused    确认已暂停 grant 的**全部写者**：扣费流量 + BullMQ 发放 job（每日 0:00/每周一 0:00 UTC）
 *                             + BalanceGrantExpiry 过期 sweep（每日 0:30 UTC）+ 事件触发发放；并避开 0:00/0:30 UTC 执行
 *                             （--include-grant execute 硬性要求；未停写者会产生 LATE_ROW ERROR / 覆盖在途扣减）
 *   --grant-first-run         声明首轮 grant execute（无 resume 依据时的显式放行；否则一律硬拒）
 *   --resume-from <file>      上次报告 JSON（MIGRATED/RESUME_APPLIED/SKIPPED_RESUME 均计入 resume；
 *                             报告中的 amountBefore/usedBefore 恒为真实前值快照，可安全链式续跑）
 *   --grant-journal <file>    grant write-ahead journal（默认 ./tokenplan-0729-grant-journal.ndjson）：改库**前**
 *                             逐行落盘前值快照，崩溃后 resume 依据（自动读取续用）；落盘失败=立即中止
 *   --plan <planId>           限定套餐（可重复；试点用）
 *   --user <userId>           限定用户（可重复；试点用）
 *   --min-monthly-credits <n> 安全闸阈值（默认 1,000,000；须为正数）
 *   --report <file>           报告输出路径（默认 ./tokenplan-0729-migration-<ts>.json）
 *   --skip-publisher-resync   跳过收尾的 publisher 全量 key-balance resync（不建议）
 *   --resync-limit <n>        resync 取 key 上限（默认 20000，需 ≥ 活跃 key 总数）
 *
 * 执行顺序红线：CreditGrantRule 面额 ×50（管理端）必须在本脚本 grant 池迁移**之后**执行。
 * grant 池默认口径（0730 执行方案 §3.3，再评审意见采纳）：盘点存量未消费 grant ≈0 时**不启用**
 * --include-grant——存量等自然过期 + 规则按新面额重发即可；仅盘点非零时才走本脚本的 grant 路径。
 * publisher resync 人工兜底：admin 端点 POST /publisher-sync-jobs/replay（billing-admin.controller）
 * 可替代/补充本 CLI 的自动 resync（如自动阶段失败或需重跑）。
 * 建议流程：dry-run 全量 → 核对 → --user 试点 execute → 全量 execute → dry-run 复核（全 ALREADY_*）
 * → publisher resync（CLI 自动）→ 用户端抽样验证。
 */
// 🔴 必须最先设置：isBillingRuntime() 在 RUIDONG_SERVICE 未设置时返回 true（codex P1-1）——
// 不设会把 SubscriptionExpiry/BalanceGrantExpiry 等生产 cron 在脚本进程里跑起来。
process.env.RUIDONG_SERVICE = process.env.RUIDONG_SERVICE || 'migration';

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from 'fs';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisModule } from '../src/redis/redis.module';
import { CreditBalanceStateService } from '../src/billing/credit-balance-state.service';
import { CreditService } from '../src/billing/credit.service';
import {
  runMigration,
  type MigrationReport,
  type RunOptions,
} from '../src/billing/tokenplan-0729-x50-migration';

/**
 * 最小引导模块（codex P1-1）：只装 CreditService + CreditBalanceStateService。
 * 不引 BillingCoreModule/PublisherModule ⇒ 不会启动任何 worker/cron/StartupPricingValidator，
 * 也不会有 PublisherSyncWorker（它无 runtime 门）。CreditService 的 publisherSync 为 @Optional，
 * 缺省 ⇒ 逐笔同步跳过——因此 execute 后**必须**跑收尾 resync（见 runPublisherResync）。
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule],
  providers: [CreditBalanceStateService, CreditService],
})
class MigrationScriptModule {}

interface CliOptions extends RunOptions {
  reportPath: string;
  journalPath: string;
  grantFirstRun: boolean;
  grantTrafficPaused: boolean;
  skipPublisherResync: boolean;
  resyncLimit: number;
}

function parseArgs(argv: string[]): CliOptions {
  const flags = argv.slice(2);
  const getAll = (name: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < flags.length; i += 1) {
      if (flags[i] === name && flags[i + 1]) values.push(flags[i + 1]);
    }
    return values;
  };
  const getOne = (name: string): string | undefined => getAll(name)[0];

  const execute = flags.includes('--execute');
  const includeGrant = flags.includes('--include-grant');
  const grantFirstRun = flags.includes('--grant-first-run');
  const grantTrafficPaused = flags.includes('--grant-traffic-paused');
  const journalPath = getOne('--grant-journal') ?? './tokenplan-0729-grant-journal.ndjson';

  // resume = journal（write-ahead 前值快照，权威）∪ 上次报告(MIGRATED/RESUME_APPLIED/SKIPPED_RESUME)。
  // 值=迁移前快照，供核心做"按前值幂等重放"（codex P0-A/P0-2）。journal 后写入，覆盖报告同 id（同值）。
  const resumeGrantRows = new Map<string, { amount: number; usedAmount: number }>();
  const resumeFrom = getOne('--resume-from');
  if (resumeFrom) {
    const prev = JSON.parse(readFileSync(resumeFrom, 'utf8')) as MigrationReport;
    for (const g of prev.grantRedemptions ?? []) {
      if (g.status === 'MIGRATED' || g.status === 'RESUME_APPLIED' || g.status === 'SKIPPED_RESUME') {
        resumeGrantRows.set(g.redemptionId, { amount: g.amountBefore, usedAmount: g.usedBefore });
      }
    }
  }
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t) as { redemptionId?: string; amount?: number; usedAmount?: number };
        if (j.redemptionId && typeof j.amount === 'number' && typeof j.usedAmount === 'number') {
          resumeGrantRows.set(j.redemptionId, { amount: j.amount, usedAmount: j.usedAmount });
        } else {
          throw new Error('字段缺失');
        }
      } catch {
        throw new Error(`journal 文件损坏行：${t.slice(0, 80)}（人工核查 ${journalPath}）`);
      }
    }
  }

  if (execute && includeGrant) {
    if (!grantTrafficPaused) {
      throw new Error(
        '--include-grant execute 必须带 --grant-traffic-paused：需暂停 grant 的全部写者' +
          '（扣费流量 + BullMQ 发放 job + BalanceGrantExpiry 过期 sweep + 事件触发发放），' +
          '并避开 0:00/0:30 UTC——否则 reconcile 可能覆盖在途扣减（超发），窗口内新增发放会 LATE_ROW 报错。',
      );
    }
    if (resumeGrantRows.size === 0 && !grantFirstRun) {
      throw new Error(
        '--include-grant execute 无任何 resume 依据（报告/journal 均空）：GrantRedemption 无幂等键，' +
          '重复执行会二次 ×50。首轮请显式带 --grant-first-run；非首轮必须 --resume-from 上次报告（journal 会自动读取）。',
      );
    }
  }

  const cutoffRaw = getOne('--cutoff');
  let cutoff: Date | null = null;
  if (cutoffRaw) {
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(cutoffRaw)) {
      throw new Error(`--cutoff 必须带显式时区（Z 或 ±hh:mm）：${cutoffRaw}`);
    }
    cutoff = new Date(cutoffRaw);
    if (Number.isNaN(cutoff.getTime())) throw new Error(`--cutoff 非法时间: ${cutoffRaw}`);
  }

  const minRaw = getOne('--min-monthly-credits');
  const minMonthlyCredits = minRaw !== undefined ? Number(minRaw) : undefined;
  const resyncRaw = getOne('--resync-limit');
  const resyncLimit = resyncRaw !== undefined ? Number(resyncRaw) : 20_000;
  if (!Number.isInteger(resyncLimit) || resyncLimit <= 0) {
    throw new Error(`--resync-limit 非法（须为正整数）: ${resyncRaw}`);
  }

  return {
    execute,
    includeBonus: flags.includes('--include-bonus'),
    includeGrant,
    cutoff,
    planIds: getAll('--plan').length ? getAll('--plan') : null,
    userIds: getAll('--user').length ? getAll('--user') : null,
    minMonthlyCredits, // 合法性由 runMigration 校验（NaN 拒绝，codex P1-5）
    resumeGrantRows,
    reportPath:
      getOne('--report') ?? `./tokenplan-0729-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    journalPath,
    grantFirstRun,
    grantTrafficPaused,
    skipPublisherResync: flags.includes('--skip-publisher-resync'),
    resyncLimit,
  };
}

/**
 * 收尾：publisher 全量 key-balance resync（迁移模块不带 publisherSync，逐笔同步被跳过；
 * 即便带了也是 fire-and-forget 不可靠——全量 resync 是必须项，codex P1-2）。
 * 用独立上下文加载 PublisherModule；期间 PublisherSyncWorker 短暂运行属预期（处理同步作业）。
 */
async function runPublisherResync(limit: number): Promise<void> {
  // 动态 import：仅 resync 阶段才加载 PublisherModule（避免主阶段引入其 worker）。
  const { PublisherModule } = await import('../src/publisher/publisher.module');
  const { PublisherSyncService } = await import('../src/publisher/publisher-sync.service');
  @Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, PublisherModule] })
  class ResyncModule {}
  const app = await NestFactory.createApplicationContext(ResyncModule, { logger: ['warn', 'error'] });
  try {
    const sync = app.get(PublisherSyncService);
    // limit+1 探测截断（返回值=遍历 key 数；单 key 失败只记 publisher 日志不抛——codex P1-B，
    // 如需强校验请按 publisher 日志 warn 计数或抽样核对网关余额）
    const synced = await sync.syncAllKeyBalances(limit + 1);
    if (synced > limit) {
      console.warn(`⚠ 活跃 key 数超过 --resync-limit=${limit}，本轮未覆盖全部——用更大的 limit 重跑收尾`);
      process.exitCode = 1;
    } else {
      console.log(`publisher key-balance 全量 resync：已遍历 ${synced} 把 key（单 key 失败以 publisher 日志为准，建议抽样核对）`);
    }
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const app = await NestFactory.createApplicationContext(MigrationScriptModule, { logger: ['warn', 'error'] });
  let report: MigrationReport;
  try {
    report = await runMigration(
      {
        prisma: app.get(PrismaService),
        credit: app.get(CreditService),
        log: (msg) => console.log(msg),
      },
      {
        ...opts,
        // write-ahead：改库前落盘前值快照并 fsync（防掉电丢尾行）；失败向上抛=中止 grant 迁移
        // （codex P0-A："已改库无 journal"是唯一会二次×50 的状态，必须由此回调的成功来排除）。
        onGrantWillMigrate: (row) => {
          const fd = openSync(opts.journalPath, 'a');
          try {
            writeSync(fd, `${JSON.stringify(row)}\n`);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        },
      },
    );
  } finally {
    await app.close();
  }

  writeFileSync(opts.reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n===== TokenPlan 0729 ×50 迁移（${report.mode}） =====`);
  console.table(report.summary);
  console.log(`报告：${opts.reportPath}（含用户余额，注意保管）`);
  if (report.summary.regrantGapCohort > 0) {
    console.warn(
      `⚠ 季付/年付 REGRANT_GAP cohort ${report.summary.regrantGapCohort} 条：月度补发 cron 缺失（既有缺陷），` +
        '历史缺发补偿与后续月度补发需另行修复；本脚本只刷新当月额度。',
    );
  }
  if (report.inactiveResidues.length > 0) {
    console.warn(`⚠ 非活跃但有余额的自营订阅 ${report.inactiveResidues.length} 条（只报不改，按财务口径另行处理）`);
  }
  if (report.activeGrantRules.length > 0) {
    console.warn(
      `⚠ 活跃 CreditGrantRule ${report.activeGrantRules.length} 条面额待 ×50（经管理端修改留审计；` +
        '必须在本脚本 grant 迁移完成后执行，并核对 rewardAmount≤10,000,000 与 globalDailyCap）',
    );
  }
  const hasErrors =
    report.summary.quotaErrors > 0 ||
    report.summary.bonusErrors > 0 ||
    report.summary.grantErrors > 0 ||
    report.summary.grantReconcileErrors > 0;
  if ((report.summary.grantReconcileMismatch ?? 0) > 0 && report.mode === 'dry-run') {
    console.warn(`⚠ dry-run 检出 grant 池 PG↔Redis 漂移 ${report.summary.grantReconcileMismatch} 个用户（fix 需 execute）`);
  }
  if (hasErrors) {
    console.error('存在 ERROR 项（含 grant 对账失败/LATE_ROW），见报告明细；修复后重跑（幂等键/journal 防重，reconcile 会全量重试）。');
    process.exitCode = 1;
  }

  if (report.mode === 'execute' && !opts.skipPublisherResync) {
    await runPublisherResync(opts.resyncLimit);
  } else if (report.mode === 'execute') {
    console.warn('⚠ 已跳过 publisher 全量 resync（--skip-publisher-resync）：网关 key 余额可能滞后，请尽快手动 resync');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
