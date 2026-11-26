/**
 * RiskFlag CRUD + lifecycle (release / permanentBan / related-users).
 *
 * Per spec §8.4 — admin-facing surface for the /risk-users page. Engine
 * itself creates flags via `createFlag` (called from RiskEngineService).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  RiskFlag,
  RiskFlagStatus,
  RiskRuleType,
  RiskSeverity,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const STATUSES: ReadonlySet<RiskFlagStatus> = new Set([
  'PENDING',
  'CONFIRMED',
  'RELEASED',
  'PERMANENT_BAN',
]);

const SEVERITIES: ReadonlySet<RiskSeverity> = new Set([
  'HIGH',
  'MEDIUM',
  'LOW',
]);

const RULE_TYPES: ReadonlySet<RiskRuleType> = new Set([
  'BLACKLIST',
  'USAGE_THRESHOLD',
  'IP_LIMIT',
  'REFUND_RATE',
  'FRAUD_PROVIDER',
]);

export interface ListFlagsFilters {
  page: number;
  pageSize: number;
  search?: string;
  ruleType?: RiskRuleType;
  severity?: RiskSeverity;
  status?: RiskFlagStatus;
  userId?: string;
  triggeredFrom?: Date;
  triggeredTo?: Date;
}

export interface CreateFlagInput {
  userId: string;
  ruleId?: string | null;
  ruleType: RiskRuleType;
  severity: RiskSeverity;
  context?: Record<string, unknown>;
  status?: RiskFlagStatus;
}

interface FlagRow extends RiskFlag {
  user?: { id: string; email: string | null; nickname: string };
  rule?: { id: string; name: string } | null;
}

@Injectable()
export class RiskFlagsService {
  private readonly logger = new Logger(RiskFlagsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------ list / get -------------------------

  async list(filters: ListFlagsFilters): Promise<{
    items: Array<{
      id: string;
      userId: string;
      userEmail: string | null;
      userNickname: string;
      ruleId: string | null;
      ruleName: string | null;
      ruleType: RiskRuleType;
      severity: RiskSeverity;
      status: RiskFlagStatus;
      context: unknown;
      triggeredAt: Date;
      resolvedAt: Date | null;
      resolvedBy: string | null;
      resolveNote: string | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const where: Prisma.RiskFlagWhereInput = {};
    if (filters.ruleType) where.ruleType = filters.ruleType;
    if (filters.severity) where.severity = filters.severity;
    if (filters.status) where.status = filters.status;
    if (filters.userId) where.userId = filters.userId;
    if (filters.triggeredFrom || filters.triggeredTo) {
      where.triggeredAt = {
        ...(filters.triggeredFrom ? { gte: filters.triggeredFrom } : {}),
        ...(filters.triggeredTo ? { lte: filters.triggeredTo } : {}),
      };
    }
    if (filters.search) {
      where.user = {
        OR: [
          { email: { contains: filters.search, mode: 'insensitive' } },
          { nickname: { contains: filters.search, mode: 'insensitive' } },
          { id: filters.search },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.riskFlag.findMany({
        where,
        orderBy: { triggeredAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
        include: {
          user: { select: { id: true, email: true, nickname: true } },
          rule: { select: { id: true, name: true } },
        },
      }) as Promise<FlagRow[]>,
      this.prisma.riskFlag.count({ where }),
    ]);

    return {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.user?.email ?? null,
        userNickname: r.user?.nickname ?? '',
        ruleId: r.ruleId,
        ruleName: r.rule?.name ?? null,
        ruleType: r.ruleType,
        severity: r.severity,
        status: r.status,
        context: this.safeParse(r.context),
        triggeredAt: r.triggeredAt,
        resolvedAt: r.resolvedAt,
        resolvedBy: r.resolvedBy,
        resolveNote: r.resolveNote,
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages: Math.ceil(total / filters.pageSize),
    };
  }

  async getById(id: string): Promise<{
    id: string;
    userId: string;
    userEmail: string | null;
    userNickname: string;
    ruleId: string | null;
    ruleName: string | null;
    ruleType: RiskRuleType;
    severity: RiskSeverity;
    status: RiskFlagStatus;
    context: unknown;
    triggeredAt: Date;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    resolveNote: string | null;
  }> {
    const row = (await this.prisma.riskFlag.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, nickname: true } },
        rule: { select: { id: true, name: true } },
      },
    })) as FlagRow | null;
    if (!row) throw new NotFoundException('风险记录不存在');
    return {
      id: row.id,
      userId: row.userId,
      userEmail: row.user?.email ?? null,
      userNickname: row.user?.nickname ?? '',
      ruleId: row.ruleId,
      ruleName: row.rule?.name ?? null,
      ruleType: row.ruleType,
      severity: row.severity,
      status: row.status,
      context: this.safeParse(row.context),
      triggeredAt: row.triggeredAt,
      resolvedAt: row.resolvedAt,
      resolvedBy: row.resolvedBy,
      resolveNote: row.resolveNote,
    };
  }

  async history(id: string): Promise<{ items: Awaited<ReturnType<RiskFlagsService['getById']>>[] }> {
    const current = await this.getById(id);
    const rows = await this.prisma.riskFlag.findMany({
      where: { userId: current.userId },
      include: {
        user: { select: { id: true, email: true, nickname: true } },
        rule: { select: { id: true, name: true } },
      },
      orderBy: { triggeredAt: 'desc' },
      take: 50,
    }) as FlagRow[];
    return {
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: r.user?.email ?? null,
        userNickname: r.user?.nickname ?? '',
        ruleId: r.ruleId,
        ruleName: r.rule?.name ?? null,
        ruleType: r.ruleType,
        severity: r.severity,
        status: r.status,
        context: this.safeParse(r.context),
        triggeredAt: r.triggeredAt,
        resolvedAt: r.resolvedAt,
        resolvedBy: r.resolvedBy,
        resolveNote: r.resolveNote,
      })),
    };
  }

  async auditLogs(id: string): Promise<{
    items: Array<{
      id: string;
      action: string;
      operatorId: string | null;
      note: string | null;
      createdAt: Date;
    }>;
  }> {
    const row = await this.prisma.riskFlag.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('风险记录不存在');
    const items = row.resolvedAt
      ? [
          {
            id: `${row.id}:resolution`,
            action: row.status === 'PERMANENT_BAN' ? '永久拉黑' : '解封',
            operatorId: row.resolvedBy,
            note: row.resolveNote,
            createdAt: row.resolvedAt,
          },
        ]
      : [];
    return { items };
  }

  // ------------------------------ create (engine-facing) -------------

  async createFlag(input: CreateFlagInput): Promise<RiskFlag> {
    if (!input.userId) {
      throw new BadRequestException('userId 必填');
    }
    if (!RULE_TYPES.has(input.ruleType)) {
      throw new BadRequestException('ruleType 非法');
    }
    if (!SEVERITIES.has(input.severity)) {
      throw new BadRequestException('severity 非法');
    }
    const status = input.status ?? 'PENDING';
    if (!STATUSES.has(status)) {
      throw new BadRequestException('status 非法');
    }
    return this.prisma.riskFlag.create({
      data: {
        userId: input.userId,
        ruleId: input.ruleId ?? null,
        ruleType: input.ruleType,
        severity: input.severity,
        context: JSON.stringify(input.context ?? {}),
        status,
      },
    });
  }

  // ------------------------------ release / ban ----------------------

  async release(
    id: string,
    operatorId: string,
    note: string,
  ): Promise<RiskFlag> {
    const row = await this.prisma.riskFlag.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('风险记录不存在');
    if (row.status === 'RELEASED') {
      throw new BadRequestException('该记录已解封');
    }
    if (row.status === 'PERMANENT_BAN') {
      throw new BadRequestException('永久封禁记录不能直接解封，请先走账号解封流程');
    }
    return this.prisma.riskFlag.update({
      where: { id },
      data: {
        status: 'RELEASED',
        resolvedAt: new Date(),
        resolvedBy: operatorId,
        resolveNote: note,
      },
    });
  }

  async permanentBan(
    id: string,
    operatorId: string,
    reason: string,
  ): Promise<RiskFlag> {
    const row = await this.prisma.riskFlag.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('风险记录不存在');
    if (row.status === 'PERMANENT_BAN') {
      throw new BadRequestException('该记录已永久封禁');
    }
    if (row.status === 'RELEASED') {
      throw new BadRequestException('已解封记录不能再次永久封禁');
    }
    // SECURITY: also flip user.isActive=false so the ban actually stops
    // future logins. The flag is the audit trail; this is the enforcement.
    // Mirrors `applyAction → FREEZE_USER` (uses updateMany with deletedAt:
    // null) so we don't resurrect a soft-deleted user by accident.
    return this.prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { id: row.userId, deletedAt: null },
        data: { isActive: false },
      });
      return tx.riskFlag.update({
        where: { id },
        data: {
          status: 'PERMANENT_BAN',
          resolvedAt: new Date(),
          resolvedBy: operatorId,
          resolveNote: reason,
        },
      });
    });
  }

  // ------------------------------ related users ----------------------

  /**
   * Find users related to the subject of this flag.
   *
   * Spec §8.4: "查找关联用户(同 IP/同设备)". Our User model does NOT have a
   * `lastLoginIp` column (PR6 scope). For now we degrade to:
   *   - For IP_LIMIT-type flags whose context.ip is known, look up other
   *     flags with the same IP in their context (best-effort).
   *   - Otherwise, return empty list with `mode: 'TODO'` so the frontend can
   *     surface a clear empty state.
   *
   * TODO(post-PR6): once `User.lastLoginIp` (and a device-fingerprint table)
   * exists, switch to a structured query against that.
   */
  async related(
    flagId: string,
  ): Promise<{
    items: Array<{
      userId: string;
      userEmail: string | null;
      userNickname: string;
      sharedSignal: string;
      flagCount: number;
    }>;
    mode: 'IP' | 'TODO';
  }> {
    const flag = await this.prisma.riskFlag.findUnique({
      where: { id: flagId },
    });
    if (!flag) throw new NotFoundException('风险记录不存在');

    const ctx = this.safeParse(flag.context) as
      | { ip?: string; ipAddress?: string }
      | null;
    const ip = ctx?.ip ?? ctx?.ipAddress;

    if (!ip || typeof ip !== 'string') {
      // No structured IP signal in context, and no User.lastLoginIp column.
      return { items: [], mode: 'TODO' };
    }

    // Find other flags whose JSON context references the same IP.
    // We use a `contains` filter on the stringified JSON — this is a coarse
    // best-effort match. Once we have a normalized column it should be
    // replaced by an indexed lookup.
    const matches = await this.prisma.riskFlag.findMany({
      where: {
        AND: [
          { context: { contains: `"${ip}"` } },
          { id: { not: flagId } },
        ],
      },
      include: {
        user: { select: { id: true, email: true, nickname: true } },
      },
      take: 100,
    });

    const grouped = new Map<
      string,
      {
        userId: string;
        userEmail: string | null;
        userNickname: string;
        sharedSignal: string;
        flagCount: number;
      }
    >();
    for (const m of matches as FlagRow[]) {
      if (m.userId === flag.userId) continue;
      const existing = grouped.get(m.userId);
      if (existing) {
        existing.flagCount += 1;
        continue;
      }
      grouped.set(m.userId, {
        userId: m.userId,
        userEmail: m.user?.email ?? null,
        userNickname: m.user?.nickname ?? '',
        sharedSignal: `IP=${ip}`,
        flagCount: 1,
      });
    }
    return {
      items: Array.from(grouped.values()),
      mode: 'IP',
    };
  }

  // ------------------------------ helpers ----------------------------

  private safeParse(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}
