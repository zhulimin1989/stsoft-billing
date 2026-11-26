import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, SegmentRuleType, UserSegment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import {
  RuleMatchTooLargeError,
  UserSegmentRuleEngine,
} from './user-segment-rule-engine';

const PREVIEW_SAMPLE_LIMIT = 50;

interface CreateSegmentInput {
  name: string;
  description?: string;
  ruleType: SegmentRuleType;
  ruleExpr?: string | null;
  isActive?: boolean;
}

interface UpdateSegmentInput {
  name?: string;
  description?: string;
  ruleExpr?: string | null;
  isActive?: boolean;
  // ruleType is intentionally not updatable post-create — switching the type
  // would orphan data (static members vs. dynamic ruleExpr).
}

interface ListFilters {
  page: number;
  pageSize: number;
  search?: string;
  ruleType?: SegmentRuleType;
  isActive?: boolean;
}

@Injectable()
export class UserSegmentsService {
  private readonly logger = new Logger(UserSegmentsService.name);
  private readonly engine: UserSegmentRuleEngine;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
  ) {
    this.engine = new UserSegmentRuleEngine(prisma);
  }

  // ------------------------------ CRUD -------------------------------

  async list(filters: ListFilters) {
    const { page, pageSize, search, ruleType, isActive } = filters;
    const where: Prisma.UserSegmentWhereInput = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (ruleType) where.ruleType = ruleType;
    if (typeof isActive === 'boolean') where.isActive = isActive;

    const [items, total] = await Promise.all([
      this.prisma.userSegment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.userSegment.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getById(id: string): Promise<UserSegment> {
    const segment = await this.prisma.userSegment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!segment) throw new NotFoundException('分群不存在');
    return segment;
  }

  async create(input: CreateSegmentInput): Promise<UserSegment> {
    if (!input.name?.trim()) throw new BadRequestException('分群名为必填');
    if (input.ruleType !== 'STATIC' && input.ruleType !== 'DYNAMIC') {
      throw new BadRequestException('ruleType 必须为 STATIC 或 DYNAMIC');
    }
    if (input.ruleType === 'DYNAMIC' && !input.ruleExpr?.trim()) {
      throw new BadRequestException('动态分群必须填写 ruleExpr');
    }
    if (input.ruleType === 'DYNAMIC' && input.ruleExpr) {
      // Validate the expression now so authors get errors at create-time rather
      // than at refresh-time (which is async).
      this.assertValidRuleExpr(input.ruleExpr);
    }
    return this.prisma.userSegment.create({
      data: {
        name: input.name,
        description: input.description ?? '',
        ruleType: input.ruleType,
        ruleExpr: input.ruleExpr ?? null,
        isActive: input.isActive ?? true,
      },
    });
  }

  async update(id: string, input: UpdateSegmentInput): Promise<UserSegment> {
    const existing = await this.getById(id);
    if (input.ruleExpr !== undefined && input.ruleExpr !== null) {
      this.assertValidRuleExpr(input.ruleExpr);
    }
    return this.prisma.userSegment.update({
      where: { id: existing.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        ...(input.ruleExpr !== undefined ? { ruleExpr: input.ruleExpr } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  }

  async softDelete(id: string): Promise<void> {
    const existing = await this.getById(id);
    await this.prisma.userSegment.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ------------------------------ rule preview / refresh ------------

  async preview(ruleExpr: string): Promise<{
    matchedCount: number;
    sampleUserIds: string[];
    capped: boolean;
    message?: string;
  }> {
    if (!ruleExpr || typeof ruleExpr !== 'string') {
      throw new BadRequestException('ruleExpr 不能为空');
    }
    this.assertValidRuleExpr(ruleExpr);
    try {
      const matched = await this.engine.resolve(ruleExpr);
      return {
        matchedCount: matched.length,
        sampleUserIds: matched.slice(0, PREVIEW_SAMPLE_LIMIT),
        capped: false,
      };
    } catch (err) {
      // The engine raises RuleMatchTooLargeError when the rule would resolve
      // more userIds than MAX_RESOLVE_SIZE. We don't bubble that to the
      // caller as a 4xx — instead we return a capped marker so the admin UI
      // can render a "请优化规则" hint without losing the editor state.
      if (err instanceof RuleMatchTooLargeError) {
        return {
          matchedCount: -1,
          sampleUserIds: [],
          capped: true,
          message: err.message,
        };
      }
      throw err;
    }
  }

  /**
   * Recompute and persist `memberCount`. For STATIC segments we count the
   * member table; for DYNAMIC we resolve the rule and store the size.
   */
  async refresh(id: string): Promise<UserSegment> {
    const segment = await this.getById(id);

    let memberCount: number;
    if (segment.ruleType === 'STATIC') {
      memberCount = await this.prisma.userSegmentMember.count({
        where: { segmentId: segment.id },
      });
    } else {
      const userIds = await this.engine.resolve(segment.ruleExpr);
      memberCount = userIds.length;
    }

    return this.prisma.userSegment.update({
      where: { id: segment.id },
      data: { memberCount },
    });
  }

  /**
   * Refresh every active DYNAMIC segment. Used by the BullMQ hourly job.
   * Errors per-segment are caught & logged so one bad ruleExpr doesn't kill
   * the batch.
   */
  async refreshAllDynamic(): Promise<{ ok: number; failed: number }> {
    const segments = await this.prisma.userSegment.findMany({
      where: { isActive: true, deletedAt: null, ruleType: 'DYNAMIC' },
      select: { id: true, ruleExpr: true },
    });
    let ok = 0;
    let failed = 0;
    for (const s of segments) {
      try {
        const userIds = await this.engine.resolve(s.ruleExpr);
        await this.prisma.userSegment.update({
          where: { id: s.id },
          data: { memberCount: userIds.length },
        });
        ok++;
      } catch (err) {
        failed++;
        this.logger.error(
          `segment-refresh failed for segment=${s.id}: ${(err as Error).message}`,
        );
      }
    }
    return { ok, failed };
  }

  // ------------------------------ members (STATIC) -------------------

  async listMembers(id: string, page: number, pageSize: number) {
    const segment = await this.getById(id);

    if (segment.ruleType === 'DYNAMIC') {
      // Materialize the rule on demand. We don't store rows for dynamic
      // segments — refresh job only updates the count.
      const userIds = await this.engine.resolve(segment.ruleExpr);
      const total = userIds.length;
      const slice = userIds.slice((page - 1) * pageSize, page * pageSize);
      const users = slice.length
        ? await this.prisma.user.findMany({
            where: { id: { in: slice } },
            select: { id: true, email: true, nickname: true, createdAt: true },
          })
        : [];
      const byId = new Map(users.map((u) => [u.id, u]));
      return {
        items: slice.map((uid) => ({
          userId: uid,
          joinedAt: null,
          user: byId.get(uid) ?? null,
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    }

    // STATIC: query the member table directly.
    const [rows, total] = await Promise.all([
      this.prisma.userSegmentMember.findMany({
        where: { segmentId: id },
        orderBy: { joinedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: {
            select: { id: true, email: true, nickname: true, createdAt: true },
          },
        },
      }),
      this.prisma.userSegmentMember.count({ where: { segmentId: id } }),
    ]);
    return {
      items: rows.map((m) => ({
        userId: m.userId,
        joinedAt: m.joinedAt,
        user: m.user,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async addMembers(
    id: string,
    userIds: string[],
  ): Promise<{ added: number; skipped: number; missing: string[] }> {
    const segment = await this.getById(id);
    if (segment.ruleType !== 'STATIC') {
      throw new BadRequestException('只有静态分群可手动添加成员');
    }
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new BadRequestException('userIds 不能为空');
    }
    if (userIds.length > 5000) {
      throw new BadRequestException('单次最多添加 5000 个成员');
    }

    // Filter to users that actually exist (and aren't soft-deleted).
    const dedup = Array.from(new Set(userIds));
    const existing = await this.prisma.user.findMany({
      where: { id: { in: dedup }, deletedAt: null },
      select: { id: true },
    });
    const existingSet = new Set(existing.map((u) => u.id));
    const missing = dedup.filter((u) => !existingSet.has(u));

    const result = await this.prisma.userSegmentMember.createMany({
      data: existing.map((u) => ({ segmentId: id, userId: u.id })),
      skipDuplicates: true,
    });

    // Update memberCount cache.
    await this.refresh(id);
    await this.syncSegmentMemberKeymeta(existing.map((u) => u.id));

    return {
      added: result.count,
      skipped: existing.length - result.count,
      missing,
    };
  }

  async removeMember(id: string, userId: string): Promise<void> {
    const segment = await this.getById(id);
    if (segment.ruleType !== 'STATIC') {
      throw new BadRequestException('只有静态分群可手动移除成员');
    }
    await this.prisma.userSegmentMember.deleteMany({
      where: { segmentId: id, userId },
    });
    await this.refresh(id);
    await this.syncSegmentMemberKeymeta([userId]);
  }

  private async syncSegmentMemberKeymeta(userIds: string[]): Promise<void> {
    if (!this.publisherSync) return;
    for (const userId of Array.from(new Set(userIds))) {
      try {
        await this.publisherSync.syncApiKeysByUserId(userId);
      } catch (err) {
        this.logger.warn(`segment keymeta sync failed user=${userId}: ${(err as Error).message}`);
      }
    }
  }

  // ------------------------------ references ------------------------

  /**
   * Discover where a segment is referenced (CreditGrantRule, Campaign,
   * DiscountCode). Those tables don't yet have a `segmentId` FK in the
   * shipped schema (later PRs add it), so for now we return empty arrays.
   * The endpoint exists so admin UI doesn't 404 on the references tab.
   */
  async references(id: string): Promise<{
    grantRules: Array<{ id: string; name: string }>;
    creditPolicies: Array<{ id: string; name: string }>;
    campaigns: Array<{ id: string; name: string }>;
    discountCodes: Array<{ id: string; code: string }>;
  }> {
    await this.getById(id);
    const [grantRules, creditPolicies] = await Promise.all([
      this.prisma.creditGrantRule.findMany({
        where: { segmentId: id, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.creditPolicy.findMany({
        where: { segmentId: id },
        select: { id: true, product: { select: { name: true } }, scope: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    return {
      grantRules,
      creditPolicies: creditPolicies.map((p) => ({
        id: p.id,
        name: `${p.product.name} / ${p.scope}`,
      })),
      campaigns: [],
      discountCodes: [],
    };
  }

  // ------------------------------ helpers ---------------------------

  private assertValidRuleExpr(ruleExpr: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ruleExpr);
    } catch {
      throw new BadRequestException('ruleExpr 必须是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException('ruleExpr 必须是对象');
    }
    // We delegate deep validation to the engine.resolve path on next preview/refresh.
    // For obviously broken shapes (not and/or/leaf), bail early:
    const obj = parsed as Record<string, unknown>;
    if (
      !Array.isArray(obj.and) &&
      !Array.isArray(obj.or) &&
      typeof obj.field !== 'string'
    ) {
      throw new BadRequestException(
        'ruleExpr 顶层必须是 { and: [] } / { or: [] } / { field, op, value }',
      );
    }
  }
}
