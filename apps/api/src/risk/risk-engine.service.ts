/**
 * Risk engine: the orchestrator that turns RiskRule rows into RiskFlag rows.
 *
 * Per spec §8.3:
 *
 *   实时检查 (real-time, on the request path):
 *     - BLACKLIST: callers ask `isUserBlocked(userId, ip, email)` before
 *                  a sensitive operation. We check active BLACKLIST rules
 *                  and the RiskList table per `matchTypes`. Returns the
 *                  list-entry that matched, or null.
 *
 *   定时扫描 (BullMQ `risk-engine` every 5 minutes):
 *     - USAGE_THRESHOLD  → SUM token usage in last `windowSec` per user
 *     - IP_LIMIT         → GROUP BY clientIp on Order, find IPs registered
 *                          to > maxAccountsPerIp distinct users
 *     - REFUND_RATE      → ratio of refunded amount in last `windowDays`,
 *                          per scope (GLOBAL / USER / PRODUCT)
 *
 * Each match creates a RiskFlag and applies the rule.action (BLOCK /
 * DISABLE_KEY / FREEZE_USER / ALERT). Default per spec is ALERT — we never
 * silently flip BLOCK on rules that don't explicitly request it.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AlertEventSeverity,
  OrderStatus,
  Prisma,
  RiskAction,
  RiskFlagStatus,
  RiskListType,
  RiskRule,
  RiskRuleType,
  RiskSeverity,
} from '@prisma/client';
import { AlertEventService } from '../alert-events/alert-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { RiskFlagsService } from './risk-flags.service';

/**
 * Cache key namespace for blocked-user lookups (spec §8.3).
 *
 * Cached value is a compact JSON envelope so callers can replay the matched
 * rule / list-entry metadata (needed for audit logging) without going back
 * to DB on a cache hit:
 *
 *   blocked  → JSON.stringify({ b: 1, r: ruleId, t: listType, v: value, x: reason })
 *   cleared  → JSON.stringify({ b: 0 })
 *
 * Parse failures (legacy "1"/"0" rows from before this change, garbage from
 * a flushdb mid-flight, etc.) are treated as a cache miss and fall through
 * to the DB path. TTL 60s, no active invalidation for IP / EMAIL match
 * types (spec decision); USER_ID-type list entries get a best-effort DEL on
 * removal (see RiskRulesService.removeEntry).
 */
export const RISK_BLOCKED_CACHE_PREFIX = 'risk:blocked:';
export const RISK_BLOCKED_CACHE_TTL_SECONDS = 60;

export interface RiskCheckResult {
  blocked: boolean;
  matchedRuleId: string | null;
  matchedListType: RiskListType | null;
  matchedValue: string | null;
  action: RiskAction | null;
  reason: string;
}

interface CachedRiskEnvelope {
  b: 0 | 1;
  r?: string | null;
  t?: RiskListType | null;
  v?: string | null;
  x?: string;
}

interface BlacklistConfig {
  matchTypes: RiskListType[];
}

interface UsageThresholdConfig {
  metric: 'DAILY_TOKEN' | 'DAILY_COST' | 'MODEL_CALL_COUNT';
  threshold: number;
  windowSec: number;
}

interface IpLimitConfig {
  windowDays: number;
  maxAccountsPerIp: number;
}

interface RefundRateConfig {
  scope: 'GLOBAL' | 'PRODUCT' | 'USER';
  thresholdPct: number;
  windowDays: number;
}

export interface ScanRuleResult {
  ruleId: string;
  ruleType: RiskRuleType;
  matched: number;
  flagsCreated: number;
}

export interface ScanAllResult {
  rulesScanned: number;
  totalMatched: number;
  totalFlagsCreated: number;
  perRule: ScanRuleResult[];
}

@Injectable()
export class RiskEngineService {
  private readonly logger = new Logger(RiskEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: RiskFlagsService,
    // Optional so existing unit tests that build the service without Redis
    // (RiskEngineService spec) keep working. The cached wrapper degrades
    // gracefully to a direct DB call when Redis isn't wired in.
    @Optional() private readonly redis?: RedisService,
    // Optional: P2-A2 hook to emit AlertEvent rows when a RiskFlag is created.
    // 单独 inject 以便在 unit test 没有 wire 时仍能跑通 RiskEngineService 单测。
    @Optional() private readonly alertEvents?: AlertEventService,
  ) {}

  // ------------------------------ Real-time check --------------------

  /**
   * BLACKLIST hook: check if a userId / email / IP matches any active
   * BLACKLIST rule. Returns the first matching list entry (with rule
   * metadata) or null.
   *
   * This is the public API caller-facing methods integrate with. We do NOT
   * mutate state here — the caller decides whether to block the request,
   * raise an alert, log the event etc.
   */
  async isUserBlocked(opts: {
    userId?: string | null;
    ip?: string | null;
    email?: string | null;
    cardHash?: string | null;
  }): Promise<RiskCheckResult> {
    const rules = await this.prisma.riskRule.findMany({
      where: {
        ruleType: 'BLACKLIST',
        isActive: true,
        deletedAt: null,
      },
    });
    if (rules.length === 0) {
      return {
        blocked: false,
        matchedRuleId: null,
        matchedListType: null,
        matchedValue: null,
        action: null,
        reason: 'no active BLACKLIST rules',
      };
    }

    // Build a probe set of (listType, value) candidates.
    const probes: Array<{ type: RiskListType; value: string }> = [];
    if (opts.userId) probes.push({ type: 'USER_ID', value: opts.userId });
    if (opts.ip) probes.push({ type: 'IP', value: opts.ip });
    if (opts.email) {
      probes.push({ type: 'EMAIL', value: opts.email.toLowerCase() });
      const at = opts.email.lastIndexOf('@');
      if (at > 0) {
        probes.push({
          type: 'DOMAIN',
          value: opts.email.slice(at + 1).toLowerCase(),
        });
      }
    }
    if (opts.cardHash)
      probes.push({ type: 'CARD_HASH', value: opts.cardHash });

    if (probes.length === 0) {
      return {
        blocked: false,
        matchedRuleId: null,
        matchedListType: null,
        matchedValue: null,
        action: null,
        reason: 'no signals to probe',
      };
    }

    for (const rule of rules) {
      const cfg = this.parseConfig<BlacklistConfig>(rule.config);
      const allowed = new Set(cfg?.matchTypes ?? []);
      // Filter probes by what this rule actually consults.
      const filtered =
        allowed.size > 0 ? probes.filter((p) => allowed.has(p.type)) : probes;
      if (filtered.length === 0) continue;

      const now = new Date();
      const entry = await this.prisma.riskList.findFirst({
        where: {
          AND: [
            {
              OR: filtered.map((p) => ({
                listType: p.type,
                value: p.value,
              })),
            },
            {
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
          ],
        },
      });
      if (entry) {
        return {
          blocked: rule.action === 'BLOCK',
          matchedRuleId: rule.id,
          matchedListType: entry.listType,
          matchedValue: entry.value,
          action: rule.action,
          reason: entry.reason || 'blacklist match',
        };
      }
    }

    return {
      blocked: false,
      matchedRuleId: null,
      matchedListType: null,
      matchedValue: null,
      action: null,
      reason: 'no blacklist match',
    };
  }

  /**
   * Redis-cached wrapper around `isUserBlocked` (spec §8.3).
   *
   * Cache key: `risk:blocked:{userId}` → "1" (blocked) | "0" (not blocked),
   * TTL 60s. Other identifiers (ip / email / cardHash) are NOT part of the
   * cache key — caching is keyed on the user identity to keep the hot path
   * (Guard) cheap. The fresh path still consults all probes, so a newly
   * blacklisted IP or email is picked up at most 60s later (spec §8.3
   * accepts this).
   *
   * Anonymous calls (no userId) bypass the cache entirely and go straight
   * to DB — that case is rare (only login-by-email-only) and we cannot
   * stably key without a userId.
   *
   * Redis failures are logged + degraded to a direct DB call (must not
   * block legitimate logins or API requests).
   */
  async isUserBlockedCached(opts: {
    userId?: string | null;
    ip?: string | null;
    email?: string | null;
    cardHash?: string | null;
  }): Promise<RiskCheckResult> {
    // No userId or no redis → cache is not useful, go direct.
    if (!opts.userId || !this.redis) {
      return this.isUserBlocked(opts);
    }

    const key = `${RISK_BLOCKED_CACHE_PREFIX}${opts.userId}`;

    // Cache GET. Treat any failure as a cache miss — never block the
    // request just because Redis is sad.
    let cached: string | null = null;
    try {
      cached = await this.redis.get(key);
    } catch (err) {
      this.logger.warn(
        `risk:blocked cache GET failed for ${opts.userId}: ${
          (err as Error).message
        } — falling through to DB`,
      );
    }

    if (cached !== null) {
      const parsed = this.parseCachedEnvelope(cached);
      if (parsed) {
        if (parsed.b === 1) {
          return {
            blocked: true,
            matchedRuleId: parsed.r ?? null,
            matchedListType: parsed.t ?? null,
            matchedValue: parsed.v ?? null,
            action: 'BLOCK',
            reason: parsed.x ?? 'cached: blocked',
          };
        }
        return {
          blocked: false,
          matchedRuleId: null,
          matchedListType: null,
          matchedValue: null,
          action: null,
          reason: 'cached: not blocked',
        };
      }
      // Dirty / legacy cache value (e.g. pre-PR0-3 "1"/"0" rows or garbage
      // injected by an external flushdb) → log + fall through to DB so we
      // refresh the entry on the SET below. We never trust an unparseable
      // value to decide a block.
      this.logger.warn(
        { key, value: cached },
        'unexpected risk cache value, treating as miss',
      );
    }

    // Cache miss (or dirty value) → do the real check.
    const fresh = await this.isUserBlocked(opts);

    // Cache SET with TTL. Same degraded-on-failure policy.
    try {
      await this.redis.set(
        key,
        this.encodeCachedEnvelope(fresh),
        'EX',
        RISK_BLOCKED_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `risk:blocked cache SET failed for ${opts.userId}: ${
          (err as Error).message
        }`,
      );
    }

    return fresh;
  }

  private parseCachedEnvelope(raw: string): CachedRiskEnvelope | null {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        ((parsed as { b: unknown }).b === 0 ||
          (parsed as { b: unknown }).b === 1)
      ) {
        return parsed as CachedRiskEnvelope;
      }
      return null;
    } catch {
      return null;
    }
  }

  private encodeCachedEnvelope(result: RiskCheckResult): string {
    if (!result.blocked) {
      return JSON.stringify({ b: 0 });
    }
    const envelope: CachedRiskEnvelope = { b: 1 };
    if (result.matchedRuleId) envelope.r = result.matchedRuleId;
    if (result.matchedListType) envelope.t = result.matchedListType;
    if (result.matchedValue) envelope.v = result.matchedValue;
    if (result.reason) envelope.x = result.reason;
    return JSON.stringify(envelope);
  }

  // ------------------------------ Scheduled scan ---------------------

  async scanAll(): Promise<ScanAllResult> {
    const rules = await this.prisma.riskRule.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        ruleType: {
          in: ['USAGE_THRESHOLD', 'IP_LIMIT', 'REFUND_RATE'],
        },
      },
    });

    const perRule: ScanRuleResult[] = [];
    let totalMatched = 0;
    let totalFlagsCreated = 0;

    for (const rule of rules) {
      try {
        const result = await this.scanRule(rule);
        perRule.push(result);
        totalMatched += result.matched;
        totalFlagsCreated += result.flagsCreated;
      } catch (err) {
        this.logger.error(
          `scanRule(${rule.id}, ${rule.ruleType}) failed: ${
            (err as Error).message
          }`,
        );
        perRule.push({
          ruleId: rule.id,
          ruleType: rule.ruleType,
          matched: 0,
          flagsCreated: 0,
        });
      }
    }

    this.logger.log(
      `scanAll done: rules=${rules.length} matched=${totalMatched} flagsCreated=${totalFlagsCreated}`,
    );

    return {
      rulesScanned: rules.length,
      totalMatched,
      totalFlagsCreated,
      perRule,
    };
  }

  async scanRule(rule: RiskRule): Promise<ScanRuleResult> {
    let matched = 0;
    let flagsCreated = 0;

    switch (rule.ruleType) {
      case 'USAGE_THRESHOLD': {
        const result = await this.scanUsageThreshold(rule);
        matched = result.matched;
        flagsCreated = result.flagsCreated;
        break;
      }
      case 'IP_LIMIT': {
        const result = await this.scanIpLimit(rule);
        matched = result.matched;
        flagsCreated = result.flagsCreated;
        break;
      }
      case 'REFUND_RATE': {
        const result = await this.scanRefundRate(rule);
        matched = result.matched;
        flagsCreated = result.flagsCreated;
        break;
      }
      default:
        // BLACKLIST / FRAUD_PROVIDER are not scheduled — handled elsewhere.
        return { ruleId: rule.id, ruleType: rule.ruleType, matched: 0, flagsCreated: 0 };
    }

    if (matched > 0) {
      await this.prisma.riskRule.update({
        where: { id: rule.id },
        data: {
          triggerCount: { increment: matched },
          lastTriggeredAt: new Date(),
        },
      });
    }

    return { ruleId: rule.id, ruleType: rule.ruleType, matched, flagsCreated };
  }

  // -------------------- USAGE_THRESHOLD --------------------------------

  private async scanUsageThreshold(
    rule: RiskRule,
  ): Promise<{ matched: number; flagsCreated: number }> {
    const cfg = this.parseConfig<UsageThresholdConfig>(rule.config);
    if (!cfg) return { matched: 0, flagsCreated: 0 };

    const since = new Date(Date.now() - cfg.windowSec * 1000);

    // Aggregate token_usage joined with api_keys → users.
    // Prisma 不支持 group-by-via-relation 的简洁写法，用 raw 查询。
    let rows: Array<{ user_id: string; total: number }> = [];
    if (cfg.metric === 'DAILY_TOKEN') {
      rows = await this.prisma.$queryRaw<
        Array<{ user_id: string; total: number }>
      >(Prisma.sql`
        SELECT k.user_id AS user_id, SUM(u.total_tokens)::int AS total
        FROM token_usage u
        JOIN api_keys k ON k.id = u.api_key_id
        WHERE u.created_at >= ${since}
        GROUP BY k.user_id
        HAVING SUM(u.total_tokens) > ${cfg.threshold}
        ORDER BY total DESC
        LIMIT 1000
      `);
    } else if (cfg.metric === 'DAILY_COST') {
      rows = await this.prisma.$queryRaw<
        Array<{ user_id: string; total: number }>
      >(Prisma.sql`
        SELECT k.user_id AS user_id, ROUND(SUM(u.cost_usd) * 100)::int AS total
        FROM token_usage u
        JOIN api_keys k ON k.id = u.api_key_id
        WHERE u.created_at >= ${since}
        GROUP BY k.user_id
        HAVING ROUND(SUM(u.cost_usd) * 100)::int > ${cfg.threshold}
        ORDER BY total DESC
        LIMIT 1000
      `);
    } else if (cfg.metric === 'MODEL_CALL_COUNT') {
      rows = await this.prisma.$queryRaw<
        Array<{ user_id: string; total: number }>
      >(Prisma.sql`
        SELECT k.user_id AS user_id, COUNT(*)::int AS total
        FROM token_usage u
        JOIN api_keys k ON k.id = u.api_key_id
        WHERE u.created_at >= ${since}
        GROUP BY k.user_id
        HAVING COUNT(*) > ${cfg.threshold}
        ORDER BY total DESC
        LIMIT 1000
      `);
    }

    let flagsCreated = 0;
    for (const row of rows) {
      const created = await this.dedupedCreateFlag(rule, row.user_id, {
        metric: cfg.metric,
        threshold: cfg.threshold,
        windowSec: cfg.windowSec,
        observed: row.total,
      });
      if (created) flagsCreated++;
      await this.applyAction(rule, row.user_id);
    }

    return { matched: rows.length, flagsCreated };
  }

  // -------------------- IP_LIMIT --------------------------------------

  private async scanIpLimit(
    rule: RiskRule,
  ): Promise<{ matched: number; flagsCreated: number }> {
    const cfg = this.parseConfig<IpLimitConfig>(rule.config);
    if (!cfg) return { matched: 0, flagsCreated: 0 };

    const since = new Date(
      Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000,
    );

    // Best signal we have for "registration IP" without a User.lastLoginIp
    // column is Order.client_ip. Group by IP, find IPs serving more than
    // `maxAccountsPerIp` distinct user_ids in the window.
    const rows = await this.prisma.$queryRaw<
      Array<{ client_ip: string; user_count: number }>
    >(Prisma.sql`
      SELECT client_ip, COUNT(DISTINCT user_id)::int AS user_count
      FROM orders
      WHERE created_at >= ${since}
        AND client_ip IS NOT NULL
        AND client_ip <> ''
      GROUP BY client_ip
      HAVING COUNT(DISTINCT user_id) > ${cfg.maxAccountsPerIp}
      ORDER BY user_count DESC
      LIMIT 200
    `);

    let matched = 0;
    let flagsCreated = 0;
    for (const row of rows) {
      // Resolve the userIds under this IP.
      const users = await this.prisma.order.findMany({
        where: { clientIp: row.client_ip, createdAt: { gte: since } },
        select: { userId: true },
        distinct: ['userId'],
        take: cfg.maxAccountsPerIp * 4,
      });
      for (const u of users) {
        matched++;
        const created = await this.dedupedCreateFlag(rule, u.userId, {
          ip: row.client_ip,
          accountsPerIp: row.user_count,
          windowDays: cfg.windowDays,
        });
        if (created) flagsCreated++;
        await this.applyAction(rule, u.userId);
      }
    }
    return { matched, flagsCreated };
  }

  // -------------------- REFUND_RATE -----------------------------------

  private async scanRefundRate(
    rule: RiskRule,
  ): Promise<{ matched: number; flagsCreated: number }> {
    const cfg = this.parseConfig<RefundRateConfig>(rule.config);
    if (!cfg) return { matched: 0, flagsCreated: 0 };

    const since = new Date(
      Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000,
    );
    const REFUND_STATUSES = [
      OrderStatus.REFUNDED,
      OrderStatus.REFUNDING,
      OrderStatus.REFUND_FAILED,
      OrderStatus.REFUND_COMPENSATION_FAILED,
    ];
    const COUNTED_STATUSES = [
      OrderStatus.PAID,
      OrderStatus.COMPLETED,
      ...REFUND_STATUSES,
    ];

    if (cfg.scope === 'GLOBAL') {
      const totals = await this.prisma.order.count({
        where: { createdAt: { gte: since }, status: { in: COUNTED_STATUSES } },
      });
      const refunded = await this.prisma.order.count({
        where: {
          createdAt: { gte: since },
          status: { in: REFUND_STATUSES },
        },
      });
      if (totals === 0) return { matched: 0, flagsCreated: 0 };
      const pct = (refunded / totals) * 100;
      if (pct <= cfg.thresholdPct) return { matched: 0, flagsCreated: 0 };

      // For GLOBAL scope we can't pin a specific user — we create a single
      // synthetic flag against a system-bucket userId. To avoid breaking
      // referential integrity we skip flag creation for GLOBAL and just
      // bump triggerCount on the rule. Operators see the trigger via the
      // rule's lastTriggeredAt.
      this.logger.warn(
        `REFUND_RATE GLOBAL rule=${rule.id} pct=${pct.toFixed(2)} > threshold=${cfg.thresholdPct} — alerting via lastTriggeredAt only (no per-user flag for GLOBAL scope)`,
      );
      return { matched: 1, flagsCreated: 0 };
    }

    if (cfg.scope === 'USER') {
      // Per-user refund rate. Find users whose refund rate exceeds threshold.
      const rows = await this.prisma.$queryRaw<
        Array<{ user_id: string; total: number; refunded: number; pct: number }>
      >(Prisma.sql`
        SELECT
          user_id,
          COUNT(*)::int AS total,
          SUM(CASE WHEN status IN ('REFUNDED', 'REFUNDING', 'REFUND_FAILED', 'REFUND_COMPENSATION_FAILED') THEN 1 ELSE 0 END)::int AS refunded,
          (SUM(CASE WHEN status IN ('REFUNDED', 'REFUNDING', 'REFUND_FAILED', 'REFUND_COMPENSATION_FAILED') THEN 1.0 ELSE 0 END) / GREATEST(COUNT(*), 1)) * 100 AS pct
        FROM orders
        WHERE created_at >= ${since}
          AND status IN ('PAID', 'COMPLETED', 'REFUNDED', 'REFUNDING', 'REFUND_FAILED', 'REFUND_COMPENSATION_FAILED')
        GROUP BY user_id
        HAVING COUNT(*) >= 3
        AND (SUM(CASE WHEN status IN ('REFUNDED', 'REFUNDING', 'REFUND_FAILED', 'REFUND_COMPENSATION_FAILED') THEN 1.0 ELSE 0 END) / COUNT(*)) * 100 > ${cfg.thresholdPct}
        ORDER BY pct DESC
        LIMIT 500
      `);

      let flagsCreated = 0;
      for (const row of rows) {
        const created = await this.dedupedCreateFlag(rule, row.user_id, {
          scope: cfg.scope,
          totalOrders: row.total,
          refundedOrders: row.refunded,
          refundRate: Number(row.pct),
          thresholdPct: cfg.thresholdPct,
          windowDays: cfg.windowDays,
        });
        if (created) flagsCreated++;
        await this.applyAction(rule, row.user_id);
      }
      return { matched: rows.length, flagsCreated };
    }

    // PRODUCT scope is rejected by RiskRulesService.validateConfig, so we
    // should never see a PRODUCT-scoped rule here. Defensive no-op + debug
    // log in case a legacy row exists from before that validation landed.
    this.logger.debug(
      `REFUND_RATE PRODUCT scope rule=${rule.id} skipped — scope no longer supported`,
    );
    return { matched: 0, flagsCreated: 0 };
  }

  // -------------------- action enforcement ----------------------------

  private async applyAction(rule: RiskRule, userId: string): Promise<void> {
    switch (rule.action) {
      case 'ALERT':
        // Flag was created with status=PENDING in dedupedCreateFlag.
        return;
      case 'BLOCK':
        // BLOCK on engine path = mark the latest pending flag as
        // PERMANENT_BAN. The actual request blocking happens via
        // isUserBlocked() at request time.
        await this.markLatestFlagStatus(rule.id, userId, 'PERMANENT_BAN');
        return;
      case 'DISABLE_KEY':
        await this.prisma.apiKey.updateMany({
          where: { userId, isActive: true, deletedAt: null },
          data: { isActive: false },
        });
        await this.markLatestFlagStatus(rule.id, userId, 'CONFIRMED');
        return;
      case 'FREEZE_USER':
        await this.prisma.user.updateMany({
          where: { id: userId, isActive: true, deletedAt: null },
          data: { isActive: false },
        });
        await this.markLatestFlagStatus(rule.id, userId, 'PERMANENT_BAN');
        return;
    }
  }

  private async markLatestFlagStatus(
    ruleId: string,
    userId: string,
    status: RiskFlagStatus,
  ): Promise<void> {
    const latest = await this.prisma.riskFlag.findFirst({
      where: { ruleId, userId, status: 'PENDING' },
      orderBy: { triggeredAt: 'desc' },
    });
    if (!latest) return;
    await this.prisma.riskFlag.update({
      where: { id: latest.id },
      data: {
        status,
        resolvedAt: new Date(),
        resolvedBy: 'risk-engine',
      },
    });
  }

  /**
   * Create a RiskFlag, dedup-style: skip if there's already a non-RELEASED
   * flag for (ruleId, userId) within the last 24h. Returns true if a flag
   * was created, false if dedup'd.
   *
   * NOTE: dedup must consider PENDING / CONFIRMED / PERMANENT_BAN — once
   * applyAction flips the flag past PENDING (DISABLE_KEY → CONFIRMED;
   * BLOCK/FREEZE_USER → PERMANENT_BAN), the next 5-min tick would otherwise
   * create a duplicate flag every cycle.
   */
  private async dedupedCreateFlag(
    rule: RiskRule,
    userId: string,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await this.prisma.riskFlag.findFirst({
      where: {
        ruleId: rule.id,
        userId,
        status: { not: 'RELEASED' },
        triggeredAt: { gte: cutoff },
      },
    });
    if (existing) return false;
    const flag = await this.flags.createFlag({
      userId,
      ruleId: rule.id,
      ruleType: rule.ruleType,
      severity: this.severityFor(rule),
      context,
      status: 'PENDING',
    });

    // P2-A2: 同步触发 AlertEvent(spec §7.1)。
    // - 严格在 RiskFlag PG 写入**后**调,失败不回滚 flag。
    // - createAlert 内部已 catch + warn,但这里再 .catch 双保险确保
    //   主链路(scanRule → applyAction)不被任何错误打断。
    // - 5 分钟去重在 createAlert 内部按 (category, sourceType, sourceId)
    //   执行,这里 sourceId=flag.id 每条都不同,实际去重作用有限,主要靠
    //   24h dedupedCreateFlag 已经把 RiskFlag 节流到一天一条。
    if (this.alertEvents) {
      void this.alertEvents
        .createAlert({
          category: 'SECURITY',
          severity: this.riskActionToAlertSeverity(rule.action),
          title: `风控触发:${rule.name}`,
          message: `规则 ${rule.name}(${rule.ruleType}/${rule.action})命中用户 ${userId}`,
          sourceType: 'risk_flag',
          sourceId: flag.id,
          userId,
          context: {
            ruleId: rule.id,
            ruleType: rule.ruleType,
            action: rule.action,
            ...context,
          },
        })
        .catch(() => {});
    }
    return true;
  }

  /**
   * RiskRule.action → AlertEventSeverity 映射(spec §7.1)。
   *   BLOCK / FREEZE_USER → CRITICAL(阻断性,需立即处理)
   *   DISABLE_KEY        → HIGH    (重要,小时级响应)
   *   ALERT              → MEDIUM  (一般,日级响应)
   * 注意与 severityFor()(写入 RiskFlag.severity)是两套语义,不能复用。
   */
  private riskActionToAlertSeverity(action: RiskAction): AlertEventSeverity {
    switch (action) {
      case 'BLOCK':
      case 'FREEZE_USER':
        return 'CRITICAL';
      case 'DISABLE_KEY':
        return 'HIGH';
      case 'ALERT':
      default:
        return 'MEDIUM';
    }
  }

  private severityFor(rule: RiskRule): RiskSeverity {
    // BLOCK / FREEZE_USER → HIGH; DISABLE_KEY → MEDIUM; ALERT → LOW.
    switch (rule.action) {
      case 'BLOCK':
      case 'FREEZE_USER':
        return 'HIGH';
      case 'DISABLE_KEY':
        return 'MEDIUM';
      case 'ALERT':
      default:
        return 'LOW';
    }
  }

  private parseConfig<T>(raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
