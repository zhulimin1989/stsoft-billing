/**
 * UserSegment rule engine.
 *
 * Parses a JSON `ruleExpr` (AND/OR composition over leaf predicates) and
 * resolves it to the list of matching `User.id`s.
 *
 * Two classes of fields:
 *  1. Direct: createdAt / subscriptionStatus / currentPlanId / signupChannel(*) /
 *     emailDomain — translatable to a Prisma `where` clause on User.
 *  2. Aggregate: monthlySpentCents / currentBalanceCents / lastActiveAt — require
 *     a raw aggregate query that produces a userId set, which is then intersected
 *     with the direct where via `User.findMany({ where: { id: { in: ... } } })`.
 *
 * (*) `signupChannel` is not (yet) a User column. We tolerate it: if used, we
 * log a warning and the predicate matches nothing (returns empty userId set).
 *
 * Operators:
 *   `>`/`gt`, `<`/`lt`, `between`, `=`/`eq`, `in`, `contains`
 */

import { BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ------------------------------ DoS guards ------------------------------
//
// Bound the rule AST so a malicious / accidental input cannot stack-overflow
// the validator nor balloon engine memory.
//
// MAX_RULE_DEPTH      — max nesting depth (root is depth 0).
// MAX_RULE_NODES      — total node count (and/or wrappers + leaves).
// MAX_RULE_BRANCH_FANOUT — max children of any single and[] / or[].
// MAX_RESOLVE_SIZE    — max userIds the engine will materialize before bailing.
//                       Prevents preview / refresh from OOMing on overly broad
//                       rules (e.g. {field:"createdAt",op:">","value":"1970-01-01"}
//                       on a 1M user table).
export const MAX_RULE_DEPTH = 16;
export const MAX_RULE_NODES = 200;
export const MAX_RULE_BRANCH_FANOUT = 32;
export const MAX_RESOLVE_SIZE = 100_000;

/**
 * Thrown by `engine.resolve` when the matched user set exceeds
 * `MAX_RESOLVE_SIZE`. Service callers catch this and surface a `capped: true`
 * response so the admin can refine the rule.
 */
export class RuleMatchTooLargeError extends BadRequestException {
  constructor(public readonly limit: number) {
    super(
      `rule matches too many users (>${limit}); refine the rule`,
    );
  }
}

// ------------------------------ types ----------------------------------

export type Op = 'gt' | 'lt' | 'eq' | 'in' | 'between' | 'contains';
export type RawOp = Op | '>' | '<' | '=';

export interface LeafRule {
  field: string;
  op: RawOp;
  value: unknown;
}
export interface AndRule {
  and: RuleNode[];
}
export interface OrRule {
  or: RuleNode[];
}
export type RuleNode = LeafRule | AndRule | OrRule;

const SUPPORTED_FIELDS = [
  'createdAt',
  'subscriptionStatus',
  'currentPlanId',
  'monthlySpentCents',
  'currentBalanceCents',
  'lastActiveAt',
  'signupChannel',
  'emailDomain',
] as const;

const AGGREGATE_FIELDS = new Set([
  'monthlySpentCents',
  'currentBalanceCents',
  'lastActiveAt',
]);

export type SupportedField = (typeof SUPPORTED_FIELDS)[number];

// ------------------------------ helpers --------------------------------

function isAndRule(n: RuleNode): n is AndRule {
  return typeof n === 'object' && n !== null && Array.isArray((n as AndRule).and);
}
function isOrRule(n: RuleNode): n is OrRule {
  return typeof n === 'object' && n !== null && Array.isArray((n as OrRule).or);
}
function isLeafRule(n: RuleNode): n is LeafRule {
  return (
    typeof n === 'object' &&
    n !== null &&
    typeof (n as LeafRule).field === 'string' &&
    typeof (n as LeafRule).op === 'string' &&
    'value' in (n as LeafRule)
  );
}

function normalizeOp(op: RawOp): Op {
  switch (op) {
    case '>':
      return 'gt';
    case '<':
      return 'lt';
    case '=':
      return 'eq';
    default:
      return op;
  }
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  throw new Error(`Invalid date value: ${JSON.stringify(v)}`);
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  throw new Error(`Invalid numeric value: ${JSON.stringify(v)}`);
}

// ------------------------------ engine ---------------------------------

export class UserSegmentRuleEngine {
  private readonly logger = new Logger(UserSegmentRuleEngine.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Parse a serialized ruleExpr (JSON string) and resolve it to matching userIds.
   * Soft-deleted users are excluded.
   *
   * @param limit  optional cap on returned userIds (used by preview / sample).
   */
  async resolve(ruleExpr: string | null | undefined, limit?: number): Promise<string[]> {
    if (!ruleExpr) return [];

    let root: RuleNode;
    try {
      const parsed = JSON.parse(ruleExpr);
      const ctx = { count: 0 };
      this.validateNode(parsed, 0, ctx);
      root = parsed as RuleNode;
    } catch (err) {
      // Preserve BadRequest typing for explicit limit violations so callers
      // can distinguish "too many users" / depth / fanout from generic parse
      // errors.
      if (err instanceof BadRequestException) throw err;
      throw new Error(
        `Invalid ruleExpr: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.evaluate(root, limit);
  }

  /**
   * Validate the entire tree up front so we surface bad input as a parse error
   * rather than a runtime SQL error mid-evaluation.
   *
   * Tracks recursion depth and a shared node counter so deeply nested or
   * sprawling rules cannot stack-overflow or memory-bomb the validator.
   */
  private validateNode(
    node: unknown,
    depth: number,
    ctx: { count: number },
  ): void {
    if (depth > MAX_RULE_DEPTH) {
      throw new BadRequestException(
        `rule depth exceeds ${MAX_RULE_DEPTH}`,
      );
    }
    if (++ctx.count > MAX_RULE_NODES) {
      throw new BadRequestException(
        `rule has more than ${MAX_RULE_NODES} nodes`,
      );
    }
    if (!node || typeof node !== 'object') {
      throw new Error('rule node must be an object');
    }
    const n = node as RuleNode;
    if (isAndRule(n)) {
      if (n.and.length === 0) throw new Error('and[] cannot be empty');
      if (n.and.length > MAX_RULE_BRANCH_FANOUT) {
        throw new BadRequestException(
          `and[] fanout exceeds ${MAX_RULE_BRANCH_FANOUT}`,
        );
      }
      n.and.forEach((c) => this.validateNode(c, depth + 1, ctx));
      return;
    }
    if (isOrRule(n)) {
      if (n.or.length === 0) throw new Error('or[] cannot be empty');
      if (n.or.length > MAX_RULE_BRANCH_FANOUT) {
        throw new BadRequestException(
          `or[] fanout exceeds ${MAX_RULE_BRANCH_FANOUT}`,
        );
      }
      n.or.forEach((c) => this.validateNode(c, depth + 1, ctx));
      return;
    }
    if (!isLeafRule(n)) {
      throw new Error('rule node must be { and: [] } | { or: [] } | { field, op, value }');
    }
    if (!(SUPPORTED_FIELDS as readonly string[]).includes(n.field)) {
      throw new Error(`unsupported field: ${n.field}`);
    }
    const op = normalizeOp(n.op);
    const allowed = ALLOWED_OPS[n.field as SupportedField];
    if (!allowed.includes(op)) {
      throw new Error(`field "${n.field}" does not support op "${n.op}"`);
    }
  }

  /**
   * Evaluate the AST. Returns userIds (sorted ascending for stability).
   *
   * Strategy:
   *   - Recursively split the tree into "direct" predicates (Prisma where) and
   *     "aggregate" predicates (raw SQL → userId set).
   *   - Aggregates are intersected (AND) / unioned (OR) with the Prisma direct
   *     branch result.
   *   - For pure-direct leaves we just push to a Prisma where; for aggregates
   *     we resolve to a userId set.
   *
   * For simplicity & correctness we use a single approach: convert every node
   * to a Set<string> of userIds, then combine. This is O(N) memory in matched
   * users, acceptable for admin-tier traffic (segments are configured by humans,
   * not hot-pathed).
   */
  private async evaluate(node: RuleNode, limit?: number): Promise<string[]> {
    const set = await this.evaluateToSet(node);
    const arr = Array.from(set).sort();
    return typeof limit === 'number' ? arr.slice(0, limit) : arr;
  }

  private async evaluateToSet(node: RuleNode): Promise<Set<string>> {
    if (isAndRule(node)) {
      let acc: Set<string> | null = null;
      for (const child of node.and) {
        const s = await this.evaluateToSet(child);
        acc = acc === null ? s : intersect(acc, s);
        if (acc.size === 0) return acc; // short-circuit
      }
      // AND can only shrink, so no size guard needed beyond child guards.
      return acc ?? new Set<string>();
    }
    if (isOrRule(node)) {
      const acc = new Set<string>();
      for (const child of node.or) {
        const s = await this.evaluateToSet(child);
        s.forEach((id) => acc.add(id));
        // Union grows monotonically — bail before we balloon memory.
        if (acc.size > MAX_RESOLVE_SIZE) {
          throw new RuleMatchTooLargeError(MAX_RESOLVE_SIZE);
        }
      }
      return acc;
    }
    return this.evaluateLeaf(node);
  }

  private async evaluateLeaf(leaf: LeafRule): Promise<Set<string>> {
    const op = normalizeOp(leaf.op);
    const field = leaf.field as SupportedField;

    if (AGGREGATE_FIELDS.has(field)) {
      return this.evaluateAggregateLeaf(field, op, leaf.value);
    }

    const where = this.directLeafToWhere(field, op, leaf.value);
    if (!where) return new Set<string>();
    // Cap the per-leaf direct query: take MAX_RESOLVE_SIZE+1 so we can detect
    // overflow without paging through the whole table.
    const rows = await this.prisma.user.findMany({
      where: { ...where, deletedAt: null },
      select: { id: true },
      take: MAX_RESOLVE_SIZE + 1,
    });
    if (rows.length > MAX_RESOLVE_SIZE) {
      throw new RuleMatchTooLargeError(MAX_RESOLVE_SIZE);
    }
    return new Set(rows.map((r) => r.id));
  }

  // -- direct (Prisma-where) leaves -------------------------------------

  private directLeafToWhere(
    field: SupportedField,
    op: Op,
    value: unknown,
  ): Record<string, unknown> | null {
    switch (field) {
      case 'createdAt': {
        return { createdAt: this.dateRange(op, value) };
      }
      case 'subscriptionStatus': {
        if (op === 'eq') {
          if (value === 'NONE') return { subscriptions: { none: {} } };
          return { subscriptions: { some: { status: value } } };
        }
        // op === 'in'
        const arr = this.expectArray(value);
        const includesNone = arr.includes('NONE');
        const concrete = arr.filter((v) => v !== 'NONE');
        if (concrete.length === 0 && includesNone) {
          return { subscriptions: { none: {} } };
        }
        const someBranch = { subscriptions: { some: { status: { in: concrete } } } };
        if (!includesNone) return someBranch;
        return { OR: [someBranch, { subscriptions: { none: {} } }] };
      }
      case 'currentPlanId': {
        // ACTIVE-only per spec (only the user's *current* plan should match).
        if (op === 'eq') {
          return {
            subscriptions: {
              some: { planId: value as string, status: 'ACTIVE' },
            },
          };
        }
        const arr = this.expectArray(value);
        return {
          subscriptions: {
            some: { planId: { in: arr }, status: 'ACTIVE' },
          },
        };
      }
      case 'signupChannel': {
        // Field doesn't exist on User yet — match nothing, but warn.
        this.logger.warn(
          `signupChannel rule used but User.signupChannel column not present; matching no users`,
        );
        return null;
      }
      case 'emailDomain': {
        const v = String(value ?? '');
        if (op === 'eq') {
          return { email: { endsWith: `@${v}` } };
        }
        // contains
        return { email: { contains: v } };
      }
      default:
        return null;
    }
  }

  private dateRange(op: Op, value: unknown): Record<string, Date> {
    if (op === 'between') {
      const [lo, hi] = this.expectArray(value);
      return { gte: toDate(lo), lte: toDate(hi) };
    }
    if (op === 'gt') return { gt: toDate(value) };
    if (op === 'lt') return { lt: toDate(value) };
    throw new Error(`unsupported date op: ${op}`);
  }

  // -- aggregate leaves -------------------------------------------------

  private async evaluateAggregateLeaf(
    field: SupportedField,
    op: Op,
    value: unknown,
  ): Promise<Set<string>> {
    if (field === 'monthlySpentCents') {
      return this.aggMonthlySpent(op, value);
    }
    if (field === 'currentBalanceCents') {
      return this.aggCurrentBalance(op, value);
    }
    if (field === 'lastActiveAt') {
      return this.aggLastActive(op, value);
    }
    return new Set<string>();
  }

  /**
   * sum(orders.amount_cents WHERE status IN ('PAID','COMPLETED') AND created_at > now-30d)
   * Compare the per-user sum against `value` using `op`.
   *
   * Uses a parameterized $queryRaw to avoid SQL injection.
   */
  private async aggMonthlySpent(op: Op, value: unknown): Promise<Set<string>> {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; total: bigint | number }>>`
      SELECT o."user_id", COALESCE(SUM(o."amount_cents"), 0) AS "total"
      FROM "orders" o
      JOIN "users" u ON u."id" = o."user_id"
      WHERE o."created_at" > ${since}
        AND o."status" IN ('PAID', 'COMPLETED')
        AND u."deleted_at" IS NULL
      GROUP BY o."user_id"
    `;
    const cmp = numericCompare(op, value);
    const matched = rows.filter((r) => cmp(Number(r.total))).map((r) => r.user_id);
    if (matched.length > MAX_RESOLVE_SIZE) {
      throw new RuleMatchTooLargeError(MAX_RESOLVE_SIZE);
    }
    return new Set(matched);
  }

  /**
   * Current wallet balance, converted to cents for existing segment rules.
   */
  private async aggCurrentBalance(op: Op, value: unknown): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string; balance: number }>>`
      SELECT ba."owner_user_id" AS "user_id", ROUND(SUM(aw."balance_usd") * 100)::int AS "balance"
      FROM "account_wallets" aw
      JOIN "billing_accounts" ba ON ba."id" = aw."billing_account_id"
      JOIN "users" u ON u."id" = ba."owner_user_id"
      WHERE u."deleted_at" IS NULL
        AND ba."owner_user_id" IS NOT NULL
        AND ba."deleted_at" IS NULL
      GROUP BY ba."owner_user_id"
    `;
    const cmp = numericCompare(op, value);
    const matched = rows.filter((r) => cmp(Number(r.balance))).map((r) => r.user_id);
    if (matched.length > MAX_RESOLVE_SIZE) {
      throw new RuleMatchTooLargeError(MAX_RESOLVE_SIZE);
    }
    return new Set(matched);
  }

  /**
   * Most recent billing-domain activity compared against the threshold.
   */
  private async aggLastActive(op: Op, value: unknown): Promise<Set<string>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string; last_active: Date | null }>
    >`
      SELECT u."id" AS "user_id",
        (
          SELECT MAX(activity."at")
          FROM (
            SELECT ak."last_used_at" AS "at"
            FROM "api_keys" ak
            WHERE ak."user_id" = u."id"
              AND ak."deleted_at" IS NULL
              AND ak."last_used_at" IS NOT NULL
            UNION ALL
            SELECT tu."created_at" AS "at"
            FROM "token_usage" tu
            JOIN "api_keys" ak ON ak."id" = tu."api_key_id"
            WHERE ak."user_id" = u."id"
            UNION ALL
            SELECT COALESCE(o."completed_at", o."paid_at", o."created_at") AS "at"
            FROM "orders" o
            WHERE o."user_id" = u."id"
              AND o."status" IN ('PAID', 'COMPLETED')
            UNION ALL
            SELECT bt."created_at" AS "at"
            FROM "balance_transactions" bt
            WHERE bt."user_id" = u."id"
            UNION ALL
            SELECT ct."created_at" AS "at"
            FROM "credit_transactions" ct
            WHERE ct."user_id" = u."id"
          ) activity
        ) AS "last_active"
      FROM "users" u
      WHERE u."deleted_at" IS NULL
    `;
    const threshold = toDate(
      Array.isArray(value) ? (value as unknown[])[0] : value,
    );
    const cmp =
      op === 'gt'
        ? (d: Date | null) => !!d && d.getTime() > threshold.getTime()
        : op === 'lt'
        ? (d: Date | null) => !!d && d.getTime() < threshold.getTime()
        : () => false;
    const matched = rows.filter((r) => cmp(r.last_active)).map((r) => r.user_id);
    if (matched.length > MAX_RESOLVE_SIZE) {
      throw new RuleMatchTooLargeError(MAX_RESOLVE_SIZE);
    }
    return new Set(matched);
  }

  // -- misc -------------------------------------------------------------

  private expectArray(v: unknown): unknown[] {
    if (!Array.isArray(v)) {
      throw new Error(`expected array value, got ${typeof v}`);
    }
    return v;
  }
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  const out = new Set<T>();
  small.forEach((v) => {
    if (large.has(v)) out.add(v);
  });
  return out;
}

function numericCompare(op: Op, value: unknown): (n: number) => boolean {
  if (op === 'between') {
    const [lo, hi] = (value as unknown[]).map(toNumber);
    return (n) => n >= lo && n <= hi;
  }
  const v = toNumber(value);
  if (op === 'gt') return (n) => n > v;
  if (op === 'lt') return (n) => n < v;
  if (op === 'eq') return (n) => n === v;
  throw new Error(`unsupported numeric op: ${op}`);
}

const ALLOWED_OPS: Record<SupportedField, Op[]> = {
  createdAt: ['gt', 'lt', 'between'],
  subscriptionStatus: ['eq', 'in'],
  currentPlanId: ['eq', 'in'],
  monthlySpentCents: ['gt', 'lt', 'between'],
  currentBalanceCents: ['gt', 'lt'],
  lastActiveAt: ['gt', 'lt'],
  signupChannel: ['eq', 'in'],
  emailDomain: ['eq', 'contains'],
};
