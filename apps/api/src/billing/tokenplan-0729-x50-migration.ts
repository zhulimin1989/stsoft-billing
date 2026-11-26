import type { PrismaClient } from '@prisma/client';

/**
 * TokenPlan 0729「积分量级 ×50」存量余额迁移（P0 止血，一次性）。
 *
 * 背景（me/TokenPlan_0730.md 根因 R1-R4）：0729 后台把三档 monthlyCredits ×50、模型倍率 ×50，
 * 但存量订阅的池余额是购买时快照，配置变更不触碰；变更单设计的"路径A 重触发开通"在源码上是
 * 幂等 no-op（订单重放短路 + grantQuota 幂等键去重），注释指望的 resetQuota 月度 cron 不存在
 * ——存量用户余额停留旧量级、却按新倍率扣费，实际价值被稀释 50 倍。
 *
 * 本迁移（=变更单路径 B 研发脚本；已按 codex 对抗评审修订）：
 *  1) quota 池：对活跃自营(platform_model_package) entitlement 逐条 resetQuota 到**新** plan.monthlyCredits
 *     （兑现公告"当月额度满额刷新、只多不少"）。复用现成 CreditService.resetQuota：自带
 *     QUOTA_RESET+QUOTA_GRANT 双流水、幂等键、余额版本、publisher key-balance 同步——零新计费原语。
 *     **cohort 冻结（codex P1）**：末次 QUOTA_GRANT 金额 ≥ 新月度额 ⇒ 该用户是配置变更后按新量级
 *     发放的新购/新切换用户，满额刷新会把其已消耗部分免费回填（超发）→ 跳过（ALREADY_NEW_SCALE）。
 *  2) bonus 池（--include-bonus，必须配 --cutoff=后台配置切换时刻）：补发差额 = **切点余额 × 49**
 *     （codex P1：切点后按新倍率的消费 C 已从旧量级余额扣走，fair=切点×50−C、现值=切点−C，
 *      差=切点×49；用"现值×49"会少补 49C）。切点余额取账本 ≤cutoff 最后一笔的 bonusAfter。
 *  3) grant 池（--include-grant）：GrantRedemption 未耗尽行 amount/usedAmount 等比 ×50（剩余=×50），
 *     乐观并发（WHERE 快照值匹配）；完成后对**全部目标用户** reconcileGrantPool(fix:true)（codex P0：
 *     grant 是 PG+Redis 双存储、Redis 为扣减热路径，只改 PG 会漂移；对账失败=ERROR 非零退出）。
 *     🔴 执行前置（codex P0-3/P1-A）：reconcile 的 SET 可能覆盖"Redis 已扣、PG 未提交"的在途扣减；
 *       发放/过期 worker（BullMQ credit-grant 每日 0:00/每周一 0:00 UTC、BalanceGrantExpiry 每日 0:30 UTC、
 *       事件触发发放）会在窗口内写 GrantRedemption → **必须暂停 grant 扣费+发放+过期全部写者**、
 *       避开 0:00/0:30 UTC 执行（CLI 强制 --grant-traffic-paused 确认）；复扫检测窗口内新增行（LATE_ROW=ERROR）。
 *     🔴 幂等（codex P0-2/P0-A）：GrantRedemption 无幂等键——**write-ahead journal**：改库前先落盘前值快照
 *       （落盘失败=致命中止）；resume 按前值快照幂等重放（行仍旧值→补上，已×50→WHERE 不中跳过），
 *       两条崩溃路径都不可能二次放大；非首轮 execute 无 resume 一律硬拒。
 *     🔴 顺序（codex P1-3）：CreditGrantRule 面额 ×50（管理端）必须在**本脚本 grant 池迁移完成之后**执行，
 *       否则新面额发放的 redemption 会被再 ×50。
 *     ⚠ 已知限制：切点→迁移窗口内的 grant 消费按"现值×50"口径，少补 49C（窗口消费极小；可按 allocations 另补）。
 *  4) 报告项（只报不改，人工/管理端决策）：非活跃但有余额的自营订阅、活跃 CreditGrantRule 面额
 *     （注意 rewardAmount≤10,000,000 校验与 globalDailyCap 需同步调整）、**季付/年付 REGRANT_GAP cohort**
 *     （既有缺陷：无月度补发 cron，此类用户历史缺发与后续月度补发需另行修复，本脚本只刷新当月）。
 *
 * 幂等性：quota/bonus 用固定 idempotencyKey（migr:0729:x50:*:<entitlementId>）+ 语义化预检
 * （同 key 非迁移流水=conflict 标 ERROR），可安全重跑；grant 用 journal/resume。默认 dry-run。
 * 收尾（必须）：CreditService 在脚本内**不带 publisherSync**（避免误启 worker，codex P1-1）——
 * execute 后 CLI 自动跑 publisher 全量 key-balance resync（syncAllKeyBalances），不可跳过除非显式 --skip-publisher-resync。
 */

export const MIGRATION_SOURCE_QUOTA = 'migration:tokenplan-0729-x50';
export const MIGRATION_SOURCE_BONUS = 'migration:tokenplan-0729-x50-bonus';
/** bonus 池目标倍数（=积分量级倍数）。 */
export const X50 = 50;
/** 执行安全闸：目标套餐 monthlyCredits 低于此值视为"配置未×50/连错环境"，拒绝 execute。 */
export const DEFAULT_MIN_MONTHLY_CREDITS = 1_000_000;

/** PG Int 上限（溢出预检：×50/×49 结果超过它 → 该条 ERROR 人工处理）。 */
export const MAX_PG_INT = 2_147_483_647;

export const quotaIdemKey = (entitlementId: string): string => `migr:0729:x50:quota:${entitlementId}`;
export const bonusIdemKey = (entitlementId: string): string => `migr:0729:x50:bonus:${entitlementId}`;
export const grantRedisKey = (userId: string): string => `credit:user:${userId}:grant`;

/** bonus 补发差额 = 基准余额 ×49（基准=配置切点余额；≤0 不补）。 */
export function bonusDiffFor(bonusAtCutoff: number): number {
  return bonusAtCutoff > 0 ? bonusAtCutoff * (X50 - 1) : 0;
}

export interface MigrationTarget {
  entitlementId: string;
  userId: string;
  tenantId: string;
  planId: string;
  planName: string;
  monthlyCredits: number;
  billingPeriod: string;
}

export interface EntitlementOutcome {
  entitlementId: string;
  userId: string;
  planId: string;
  planName: string;
  before: { quota: number; bonus: number; grant: number };
  quotaTarget: number;
  /** 末次 QUOTA_GRANT 金额（cohort 判别依据；null=无发放流水）。 */
  lastQuotaGrant: number | null;
  /** 切点 bonus 余额（--cutoff 时按账本回溯；无 cutoff 时=现值）。 */
  bonusAtCutoff: number;
  bonusDiff: number;
  quotaStatus: 'DRY_RUN' | 'MIGRATED' | 'ALREADY_MIGRATED' | 'ALREADY_NEW_SCALE' | 'ERROR';
  bonusStatus:
    | 'DRY_RUN'
    | 'MIGRATED'
    | 'ALREADY_MIGRATED'
    | 'ALREADY_NEW_SCALE'
    | 'SKIPPED_ZERO'
    | 'DISABLED'
    | 'ERROR';
  /** 季付/年付：月度补发 cron 缺失的既有缺陷 cohort（历史缺发需另行补偿，本脚本只刷新当月）。 */
  regrantGap: boolean;
  error?: string;
}

export interface GrantRedemptionOutcome {
  redemptionId: string;
  userId: string;
  amountBefore: number;
  usedBefore: number;
  status: 'DRY_RUN' | 'MIGRATED' | 'RESUME_APPLIED' | 'SKIPPED_RESUME' | 'RACE_SKIPPED' | 'ERROR';
  error?: string;
}

/** grant 池 PG↔Redis 对账结果（execute=fix 回写、对全部目标用户；dry-run=只检不改，暴露漂移）。 */
export interface GrantReconcileOutcome {
  userId: string;
  status: 'OK' | 'ERROR';
  expected?: number;
  redisBefore?: number | null;
  mismatched?: boolean;
  fixed?: boolean;
  error?: string;
}

export interface MigrationReport {
  startedAt: string;
  finishedAt: string;
  mode: 'dry-run' | 'execute';
  options: {
    includeBonus: boolean;
    includeGrant: boolean;
    planIds: string[] | null;
    userIds: string[] | null;
    minMonthlyCredits: number;
    cutoff: string | null;
  };
  entitlements: EntitlementOutcome[];
  grantRedemptions: GrantRedemptionOutcome[];
  grantReconcile: GrantReconcileOutcome[];
  /** 只报不改：非活跃但有余额的自营订阅（财务口径决定清零或×50 后另行处理）。 */
  inactiveResidues: Array<{
    entitlementId: string;
    userId: string;
    planId: string;
    status: string;
    quota: number;
    bonus: number;
  }>;
  /** 只报不改：活跃 CreditGrantRule 面额（建议经管理端 ×50，留审计）。 */
  activeGrantRules: Array<{ ruleId: string; name: string; rewardAmount: number; suggested: number }>;
  summary: Record<string, number>;
}

/** 迁移所需的最小依赖面（生产由 Nest 容器注入真实实现；单测注入桩）。 */
export interface MigrationDeps {
  prisma: PrismaClient;
  credit: {
    getAuthoritativeBalances(
      subscriptionId: string,
      userId: string,
    ): Promise<{ quota: number; bonus: number; grant: number; total: number }>;
    resetQuota(
      subscriptionId: string,
      userId: string,
      newQuota: number,
      source: string,
      opts: { idempotencyKey: string },
    ): Promise<void>;
    addBonus(
      subscriptionId: string,
      userId: string,
      credits: number,
      source: string,
      opts: { idempotencyKey: string },
    ): Promise<void>;
    /** grant 池 PG↔Redis 对账（fix=true 回写 Redis）；grant 行 ×50 后必须逐用户调用，防双存储漂移。 */
    reconcileGrantPool(
      userId: string,
      opts?: { fix?: boolean },
    ): Promise<{ userId: string; expected: number; redis: number | null; mismatched: boolean; fixed: boolean }>;
  };
  log: (msg: string) => void;
}

export interface RunOptions {
  execute: boolean;
  includeBonus: boolean;
  includeGrant: boolean;
  planIds?: string[] | null;
  userIds?: string[] | null;
  minMonthlyCredits?: number;
  /**
   * resume 映射：redemptionId → 迁移前快照值（journal/上次报告）。重放语义（幂等）：
   * 命中 id 时不盲目跳过，而是按**快照前值**再尝试一次 updateMany——
   * 行仍是前值（上次 journal 后、提交前崩溃）→ 本次补上（RESUME_APPLIED）；
   * 行已是 ×50 后值 → WHERE 不中，安全跳过（SKIPPED_RESUME）。两种都不会二次放大。
   */
  resumeGrantRows?: Map<string, { amount: number; usedAmount: number }>;
  /** 0729 后台配置切换时刻；--include-bonus 必填（bonus 补偿基准=切点余额）。 */
  cutoff?: Date | null;
  /**
   * grant 行 **write-ahead journal** 回调：在 updateMany **之前**同步落盘（含前值快照）。
   * 抛错=致命：立即中止整个 grant 迁移（不吞不降级）——journal 写不进去时绝不允许改库，
   * 否则"已×50 但无 journal"重跑必然二次放大（codex P0-A）。
   */
  onGrantWillMigrate?: (row: { redemptionId: string; userId: string; amount: number; usedAmount: number }) => void;
}

/** 目标=活跃、未过期、自营 platform_model_package、plan.monthlyCredits>0 的 entitlement。 */
export async function loadTargets(
  prisma: PrismaClient,
  filter: { planIds?: string[] | null; userIds?: string[] | null },
): Promise<MigrationTarget[]> {
  const rows = await prisma.codingPlanEntitlement.findMany({
    where: {
      fulfillmentMode: 'platform_model_package',
      status: 'ACTIVE',
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(filter.planIds?.length ? { planId: { in: filter.planIds } } : {}),
      ...(filter.userIds?.length ? { userId: { in: filter.userIds } } : {}),
    },
    select: { id: true, userId: true, tenantId: true, planId: true, billingPeriod: true },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const planIds = Array.from(new Set(rows.map((r) => r.planId)));
  const plans = await prisma.plan.findMany({
    where: { id: { in: planIds } },
    select: { id: true, name: true, monthlyCredits: true },
  });
  const planById = new Map(plans.map((p) => [p.id, p]));
  return rows.flatMap((r) => {
    const plan = planById.get(r.planId);
    if (!plan || plan.monthlyCredits <= 0) return [];
    return [
      {
        entitlementId: r.id,
        userId: r.userId,
        tenantId: r.tenantId,
        planId: r.planId,
        planName: plan.name,
        monthlyCredits: plan.monthlyCredits,
        billingPeriod: r.billingPeriod,
      },
    ];
  });
}

/**
 * 幂等预检（语义校验版）：迁移流水已存在 → 'done'（上次已迁）；
 * 同 key 存在但 type/source 不符 → 'conflict'（异常流水占用迁移键，绝不静默放过，标 ERROR 人工核）。
 */
async function migrationTxCheck(
  prisma: PrismaClient,
  idempotencyKey: string,
  expect: { type: string; source: string; subscriptionId: string; userId: string; creditsAmount?: number },
): Promise<'none' | 'done' | 'conflict'> {
  const existing = await prisma.creditTransaction.findUnique({
    where: { idempotencyKey },
    select: { type: true, source: true, subscriptionId: true, userId: true, creditsAmount: true },
  });
  if (!existing) return 'none';
  const ok =
    existing.type === expect.type &&
    existing.source === expect.source &&
    existing.subscriptionId === expect.subscriptionId &&
    existing.userId === expect.userId &&
    (expect.creditsAmount === undefined || existing.creditsAmount === expect.creditsAmount);
  return ok ? 'done' : 'conflict';
}

/**
 * 末次**业务** QUOTA_GRANT 金额（cohort 判别：≥新月度额=配置后新量级发放，跳过防超发）。
 * **必须排除迁移自身流水**（codex P0-1）：否则第一轮 resetQuota 写入的新额度会让分阶段补跑
 * bonus 时被误判 ALREADY_NEW_SCALE，bonus 永久漏补。排序带 id tiebreaker（同毫秒稳定）。
 */
async function latestQuotaGrantAmount(prisma: PrismaClient, subscriptionId: string): Promise<number | null> {
  const tx = await prisma.creditTransaction.findFirst({
    where: { subscriptionId, type: 'QUOTA_GRANT', NOT: { source: MIGRATION_SOURCE_QUOTA } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { creditsAmount: true },
  });
  return tx ? tx.creditsAmount : null;
}

/** 切点 bonus 余额：账本 ≤cutoff 最后一笔的 bonusAfter（无流水=0；未传 cutoff=现值兜底）。 */
async function bonusBalanceAtCutoff(
  prisma: PrismaClient,
  subscriptionId: string,
  cutoff: Date | null | undefined,
  currentBonus: number,
): Promise<number> {
  if (!cutoff) return currentBonus;
  const tx = await prisma.creditTransaction.findFirst({
    where: { subscriptionId, createdAt: { lte: cutoff } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { bonusAfter: true },
  });
  return tx?.bonusAfter ?? 0;
}

export async function migrateEntitlement(
  deps: MigrationDeps,
  target: MigrationTarget,
  opts: Pick<RunOptions, 'execute' | 'includeBonus' | 'cutoff'>,
): Promise<EntitlementOutcome> {
  const outcome: EntitlementOutcome = {
    entitlementId: target.entitlementId,
    userId: target.userId,
    planId: target.planId,
    planName: target.planName,
    before: { quota: 0, bonus: 0, grant: 0 },
    quotaTarget: target.monthlyCredits,
    lastQuotaGrant: null,
    bonusAtCutoff: 0,
    bonusDiff: 0,
    quotaStatus: 'DRY_RUN',
    bonusStatus: opts.includeBonus ? 'DRY_RUN' : 'DISABLED',
    regrantGap: target.billingPeriod !== 'monthly',
  };
  try {
    const balances = await deps.credit.getAuthoritativeBalances(target.entitlementId, target.userId);
    outcome.before = { quota: balances.quota, bonus: balances.bonus, grant: balances.grant };
    outcome.lastQuotaGrant = await latestQuotaGrantAmount(deps.prisma, target.entitlementId);
    outcome.bonusAtCutoff = await bonusBalanceAtCutoff(
      deps.prisma,
      target.entitlementId,
      opts.cutoff,
      balances.bonus,
    );
    outcome.bonusDiff = bonusDiffFor(outcome.bonusAtCutoff);

    // cohort 冻结：末次发放已是新量级（新购/新切换/已被本迁移刷新）→ 整条跳过防超发。
    const newScale =
      outcome.lastQuotaGrant !== null && outcome.lastQuotaGrant >= target.monthlyCredits;

    // 语义化幂等预检（全字段：type/source/归属/金额）；conflict 只废本池，另一池独立继续（codex P1-C）。
    const quotaCheck = await migrationTxCheck(deps.prisma, quotaIdemKey(target.entitlementId), {
      type: 'QUOTA_GRANT',
      source: MIGRATION_SOURCE_QUOTA,
      subscriptionId: target.entitlementId,
      userId: target.userId,
      creditsAmount: target.monthlyCredits,
    });
    const bonusCheck = opts.includeBonus
      ? await migrationTxCheck(deps.prisma, bonusIdemKey(target.entitlementId), {
          type: 'BONUS_PURCHASE',
          source: MIGRATION_SOURCE_BONUS,
          subscriptionId: target.entitlementId,
          userId: target.userId,
          creditsAmount: outcome.bonusDiff, // cutoff 派生值可确定重算；金额不符=历史异常应 conflict
        })
      : 'none';
    if (quotaCheck === 'conflict') {
      outcome.quotaStatus = 'ERROR';
      outcome.error = 'IDEMPOTENCY_CONFLICT(quota): 迁移幂等键被语义不符流水占用，人工核查';
    }
    if (bonusCheck === 'conflict') {
      outcome.bonusStatus = 'ERROR';
      outcome.error = `${outcome.error ? outcome.error + '; ' : ''}IDEMPOTENCY_CONFLICT(bonus): 迁移幂等键被语义不符流水占用，人工核查`;
    }
    const quotaDone = quotaCheck === 'done';
    const bonusDone = bonusCheck === 'done';

    const resolveQuotaSkip = (): boolean => {
      if (quotaCheck === 'conflict') return true; // 状态已置 ERROR，本池废弃
      if (quotaDone) {
        outcome.quotaStatus = 'ALREADY_MIGRATED';
        return true;
      }
      if (newScale) {
        outcome.quotaStatus = 'ALREADY_NEW_SCALE';
        return true;
      }
      return false;
    };
    const resolveBonusSkip = (): boolean => {
      if (!opts.includeBonus) return true; // DISABLED 已置
      if (bonusCheck === 'conflict') return true; // 状态已置 ERROR，本池废弃
      if (bonusDone) {
        outcome.bonusStatus = 'ALREADY_MIGRATED';
        return true;
      }
      if (newScale) {
        outcome.bonusStatus = 'ALREADY_NEW_SCALE';
        return true;
      }
      if (outcome.bonusDiff <= 0) {
        outcome.bonusStatus = 'SKIPPED_ZERO';
        return true;
      }
      if (outcome.bonusDiff > MAX_PG_INT) {
        outcome.bonusStatus = 'ERROR';
        outcome.error = `bonus 差额 ${outcome.bonusDiff} 超 PG Int 上限，人工处理`;
        return true;
      }
      return false;
    };

    const quotaSkip = resolveQuotaSkip();
    const bonusSkip = resolveBonusSkip();
    if (!opts.execute) return outcome; // dry-run：状态已如实标注（DRY_RUN=将执行）

    // quota：满额刷新到新 monthlyCredits（resetQuota=清旧+发新双流水，幂等键防重）。
    if (!quotaSkip) {
      await deps.credit.resetQuota(
        target.entitlementId,
        target.userId,
        target.monthlyCredits,
        MIGRATION_SOURCE_QUOTA,
        { idempotencyKey: quotaIdemKey(target.entitlementId) },
      );
      outcome.quotaStatus = 'MIGRATED';
    }

    // bonus：补切点余额 ×49 差额（增量语义）。
    if (!bonusSkip) {
      await deps.credit.addBonus(
        target.entitlementId,
        target.userId,
        outcome.bonusDiff,
        MIGRATION_SOURCE_BONUS,
        { idempotencyKey: bonusIdemKey(target.entitlementId) },
      );
      outcome.bonusStatus = 'MIGRATED';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    outcome.error = outcome.error ? `${outcome.error}; ${msg}` : msg;
    if (outcome.quotaStatus === 'DRY_RUN') outcome.quotaStatus = 'ERROR';
    if (outcome.bonusStatus === 'DRY_RUN') outcome.bonusStatus = 'ERROR';
  }
  return outcome;
}

/**
 * grant 池 ×50：未过期未耗尽 GrantRedemption 行 amount/usedAmount 等比放大（剩余=×50）。
 * 乐观并发：WHERE 带快照值，期间被消费则本行跳过（RACE_SKIPPED，重跑再处理）。
 * 完成后逐用户 reconcileGrantPool(fix:true)：grant 是 PG+Redis 双存储且 Redis 为扣减热路径，
 * 只改 PG 会造成"publisher 按 PG 镜像大余额、实际扣减用旧 Redis 值"的漂移（codex P0）。
 */
export async function migrateGrantRedemptions(
  deps: MigrationDeps,
  userIds: string[],
  opts: Pick<RunOptions, 'execute' | 'onGrantWillMigrate' | 'resumeGrantRows'>,
): Promise<{ rows: GrantRedemptionOutcome[]; reconcile: GrantReconcileOutcome[] }> {
  if (userIds.length === 0) return { rows: [], reconcile: [] };
  if (opts.execute && !opts.onGrantWillMigrate) {
    // 防绕过：write-ahead journal 是 grant 幂等的全部依据，execute 缺 callback 一律拒绝。
    throw new Error('migrateGrantRedemptions execute 必须提供 onGrantWillMigrate（write-ahead journal）');
  }
  const scanWhere = {
    userId: { in: userIds },
    isExpired: false,
    isUsedUp: false,
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
  const rows = await deps.prisma.grantRedemption.findMany({
    where: scanWhere,
    select: { id: true, userId: true, amount: true, usedAmount: true },
    orderBy: { createdAt: 'asc' },
  });
  const outcomes: GrantRedemptionOutcome[] = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    seenIds.add(row.id);
    const base: GrantRedemptionOutcome = {
      redemptionId: row.id,
      userId: row.userId,
      amountBefore: row.amount,
      usedBefore: row.usedAmount,
      status: 'DRY_RUN',
    };
    const resume = opts.resumeGrantRows?.get(row.id);
    if (resume) {
      // 🔴 报告恒携带**真实前值**（journal 快照），而非扫描到的当前值（已迁行=×50 后值）——
      // 否则"报告→下一轮 --resume-from"链式续跑会把 ×50 后值当前值重放，命中 WHERE 再 ×50（codex 终审 P0）。
      base.amountBefore = resume.amount;
      base.usedBefore = resume.usedAmount;
      if (!opts.execute) {
        base.status = 'SKIPPED_RESUME';
        outcomes.push(base);
        continue;
      }
      // 幂等重放：按 journal 前值快照条件更新——行仍是前值（上次 journal 后崩溃）→ 本次补上。
      try {
        const applied = await deps.prisma.grantRedemption.updateMany({
          where: { id: row.id, amount: resume.amount, usedAmount: resume.usedAmount },
          data: { amount: resume.amount * X50, usedAmount: resume.usedAmount * X50 },
        });
        if (applied.count === 1) {
          base.status = 'RESUME_APPLIED';
        } else {
          // WHERE 不中 ≠ 一定已迁（codex 终审 P1）：RACE_SKIPPED 行也进了 journal——盲判跳过=静默漏迁。
          // 重读行值三态判定：恰为 snapshot×50 → 已迁跳过；否则发散（并发消费/异常）→ ERROR 人工核。
          const now = await deps.prisma.grantRedemption.findUnique({
            where: { id: row.id },
            select: { amount: true, usedAmount: true },
          });
          if (now && now.amount === resume.amount * X50 && now.usedAmount === resume.usedAmount * X50) {
            base.status = 'SKIPPED_RESUME';
          } else {
            base.status = 'ERROR';
            base.error = `RESUME_DIVERGED: 行值(${now?.amount}/${now?.usedAmount})既非快照前值也非×50后值，人工核查`;
          }
        }
      } catch (err) {
        base.status = 'ERROR';
        base.error = err instanceof Error ? err.message : String(err);
      }
      outcomes.push(base);
      continue;
    }
    if (!opts.execute) {
      outcomes.push(base);
      continue;
    }
    if (row.amount * X50 > MAX_PG_INT || row.usedAmount * X50 > MAX_PG_INT) {
      base.status = 'ERROR';
      base.error = `×50 超 PG Int 上限（amount=${row.amount}），人工处理`;
      outcomes.push(base);
      continue;
    }
    // write-ahead journal：先落盘（含前值）再改库。落盘抛错=致命中止（不 catch），
    // 保证"改过库的行必有 journal"这一不变量——resume 的安全性完全依赖它。
    opts.onGrantWillMigrate?.({
      redemptionId: row.id,
      userId: row.userId,
      amount: row.amount,
      usedAmount: row.usedAmount,
    });
    try {
      const updated = await deps.prisma.grantRedemption.updateMany({
        where: { id: row.id, amount: row.amount, usedAmount: row.usedAmount },
        data: { amount: row.amount * X50, usedAmount: row.usedAmount * X50 },
      });
      base.status = updated.count === 1 ? 'MIGRATED' : 'RACE_SKIPPED';
    } catch (err) {
      base.status = 'ERROR';
      base.error = err instanceof Error ? err.message : String(err);
    }
    outcomes.push(base);
  }

  // 迁移窗口新增发放检测（codex P1-A）：发放/过期 worker 若未真正暂停，扫描后可能又冒出旧面额行。
  // 复扫一次，未见过的行=窗口内新增 → 标 ERROR（不写库），非零退出逼人工确认 worker 已停后重跑。
  if (opts.execute) {
    const rescan = await deps.prisma.grantRedemption.findMany({
      where: scanWhere,
      select: { id: true, userId: true, amount: true, usedAmount: true },
    });
    for (const late of rescan) {
      if (seenIds.has(late.id)) continue;
      outcomes.push({
        redemptionId: late.id,
        userId: late.userId,
        amountBefore: late.amount,
        usedBefore: late.usedAmount,
        status: 'ERROR',
        error: 'LATE_ROW: 迁移窗口内新增 grant 发放——确认发放/过期 worker 已暂停后重跑（带 resume）',
      });
    }
  }

  // 双存储对账（codex P0-4 / P2）：execute=fix 回写（对全部目标用户，重跑修复上轮失败）；
  // dry-run=只检不改（fix:false），提前暴露 PG↔Redis 漂移。失败=ERROR 计入 summary、CLI 非零退出。
  const reconcile: GrantReconcileOutcome[] = [];
  for (const uid of userIds) {
    try {
      const r = await deps.credit.reconcileGrantPool(uid, { fix: opts.execute });
      reconcile.push({
        userId: uid,
        status: 'OK',
        expected: r.expected,
        redisBefore: r.redis,
        mismatched: r.mismatched,
        fixed: r.fixed,
      });
    } catch (err) {
      reconcile.push({
        userId: uid,
        status: 'ERROR',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { rows: outcomes, reconcile };
}

/** 只报不改：非活跃(非 ACTIVE 或已过期)但仍有池余额的自营订阅。 */
export async function listInactiveResidues(prisma: PrismaClient): Promise<MigrationReport['inactiveResidues']> {
  const now = new Date();
  const rows = await prisma.codingPlanEntitlement.findMany({
    where: {
      fulfillmentMode: 'platform_model_package',
      OR: [{ status: { not: 'ACTIVE' } }, { expiresAt: { not: null, lte: now } }],
    },
    select: { id: true, userId: true, planId: true, status: true },
  });
  if (rows.length === 0) return [];
  const states = await prisma.creditBalanceState.findMany({
    where: { subscriptionId: { in: rows.map((r) => r.id) }, OR: [{ quota: { gt: 0 } }, { bonus: { gt: 0 } }] },
    select: { subscriptionId: true, quota: true, bonus: true },
  });
  const stateById = new Map(states.map((s) => [s.subscriptionId, s]));
  return rows.flatMap((r) => {
    const s = stateById.get(r.id);
    if (!s) return [];
    return [{ entitlementId: r.id, userId: r.userId, planId: r.planId, status: r.status, quota: s.quota, bonus: s.bonus }];
  });
}

/** 只报不改：活跃 CreditGrantRule 面额与 ×50 建议值（经管理端修改留审计）。 */
export async function listActiveGrantRules(prisma: PrismaClient): Promise<MigrationReport['activeGrantRules']> {
  const rules = await prisma.creditGrantRule.findMany({
    where: { isActive: true },
    select: { id: true, name: true, rewardAmount: true },
  });
  return rules.map((r) => ({ ruleId: r.id, name: r.name, rewardAmount: r.rewardAmount, suggested: r.rewardAmount * X50 }));
}

export async function runMigration(deps: MigrationDeps, opts: RunOptions): Promise<MigrationReport> {
  const startedAt = new Date().toISOString();
  const minMonthly = opts.minMonthlyCredits ?? DEFAULT_MIN_MONTHLY_CREDITS;
  if (!Number.isFinite(minMonthly) || minMonthly <= 0) {
    throw new Error(`--min-monthly-credits 非法（${String(minMonthly)}）：必须为正数，安全闸不可被 NaN 绕过`);
  }
  if (opts.includeBonus && !opts.cutoff) {
    throw new Error('--include-bonus 必须提供 --cutoff（0729 后台配置切换时刻）：bonus 补偿基准=切点余额×49');
  }
  const targets = await loadTargets(deps.prisma, { planIds: opts.planIds, userIds: opts.userIds });
  deps.log(`目标活跃自营 entitlement：${targets.length} 条（mode=${opts.execute ? 'execute' : 'dry-run'}）`);
  if (opts.execute && targets.length === 0) {
    throw new Error('目标为空却要求 execute：疑似连错环境/过滤条件写错，拒绝执行（dry-run 可用于确认）');
  }

  // 安全闸：任一目标套餐 monthlyCredits 低于阈值 → 配置疑似未×50/连错环境，拒绝 execute。
  const lowPlans = Array.from(
    new Map(targets.filter((t) => t.monthlyCredits < minMonthly).map((t) => [t.planId, t])).values(),
  );
  if (opts.execute && lowPlans.length > 0) {
    throw new Error(
      `安全闸拒绝执行：以下套餐 monthlyCredits < ${minMonthly}（疑似 0729 配置未生效或连错环境）：` +
        lowPlans.map((p) => `${p.planName}(${p.planId})=${p.monthlyCredits}`).join(', ') +
        '；确认无误可用 --min-monthly-credits 调低阈值。',
    );
  }

  const entitlements: EntitlementOutcome[] = [];
  for (const target of targets) {
    const outcome = await migrateEntitlement(deps, target, {
      execute: opts.execute,
      includeBonus: opts.includeBonus,
      cutoff: opts.cutoff,
    });
    entitlements.push(outcome);
    if (outcome.error) deps.log(`✗ ${target.entitlementId} (${target.planName}) ${outcome.error}`);
  }

  const grantResult = opts.includeGrant
    ? await migrateGrantRedemptions(deps, Array.from(new Set(targets.map((t) => t.userId))), opts)
    : { rows: [], reconcile: [] };
  const grantRedemptions = grantResult.rows;
  const grantReconcile = grantResult.reconcile;

  const [inactiveResidues, activeGrantRules] = await Promise.all([
    listInactiveResidues(deps.prisma),
    listActiveGrantRules(deps.prisma),
  ]);

  const count = <T,>(arr: T[], pick: (x: T) => string) => (val: string) =>
    arr.filter((x) => pick(x) === val).length;
  const q = count(entitlements, (e) => e.quotaStatus);
  const b = count(entitlements, (e) => e.bonusStatus);
  const g = count(grantRedemptions, (e) => e.status);
  const report: MigrationReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: opts.execute ? 'execute' : 'dry-run',
    options: {
      includeBonus: opts.includeBonus,
      includeGrant: opts.includeGrant,
      planIds: opts.planIds ?? null,
      userIds: opts.userIds ?? null,
      minMonthlyCredits: minMonthly,
      cutoff: opts.cutoff ? opts.cutoff.toISOString() : null,
    },
    entitlements,
    grantRedemptions,
    grantReconcile,
    inactiveResidues,
    activeGrantRules,
    summary: {
      targets: targets.length,
      quotaMigrated: q('MIGRATED'),
      quotaAlready: q('ALREADY_MIGRATED'),
      quotaNewScaleSkipped: q('ALREADY_NEW_SCALE'),
      quotaErrors: q('ERROR'),
      bonusMigrated: b('MIGRATED'),
      bonusAlready: b('ALREADY_MIGRATED'),
      bonusNewScaleSkipped: b('ALREADY_NEW_SCALE'),
      bonusErrors: b('ERROR'),
      grantMigrated: g('MIGRATED'),
      grantResumeApplied: g('RESUME_APPLIED'),
      grantRaceSkipped: g('RACE_SKIPPED'),
      grantSkippedResume: g('SKIPPED_RESUME'),
      grantErrors: g('ERROR'),
      grantReconcileErrors: grantReconcile.filter((r) => r.status === 'ERROR').length,
      grantReconcileMismatch: grantReconcile.filter((r) => r.mismatched === true).length,
      regrantGapCohort: entitlements.filter((e) => e.regrantGap).length,
      inactiveResidues: inactiveResidues.length,
      activeGrantRules: activeGrantRules.length,
    },
  };
  return report;
}
