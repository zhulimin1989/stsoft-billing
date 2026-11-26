/**
 * Ticket + TicketMessage 客服工单 service.
 *
 * Per spec §9 of admin-v2-backend-p1. Covers:
 *   - CRUD (admin + user views, with `isInternal` filtering for users)
 *   - ticketNumber generation via Redis INCR (TKT-YYYYMMDD-NNNNN), with
 *     UUID-based fallback when Redis is unavailable so requests never hang.
 *   - Status transitions guarded against illegal jumps. Re-open path is
 *     CLOSED → IN_PROGRESS only (user cannot RESOLVE a CLOSED ticket).
 *   - Reply (admin / user) with internal-note flag.
 *   - Assign / category / priority mutators (admin-only).
 *   - Merge: move all messages from src → dst, mark src CLOSED with a SYSTEM
 *     audit message in both tickets so the trail is preserved.
 *   - SLA scan (called from BullMQ): for each priority tier, flag overdue
 *     OPEN/IN_PROGRESS tickets via AlertEvent business events.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Ticket,
  AlertEventSeverity,
  TicketAuthorType,
  TicketCategory,
  TicketMessage,
  TicketPriority,
  TicketStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SUBJECT_MAX = 200;
const CONTENT_MAX = 10_000;
const ATTACHMENT_MAX = 20;
const ATTACHMENT_URL_MAX = 1024;

const CATEGORIES: ReadonlySet<TicketCategory> = new Set([
  'BILLING',
  'TECHNICAL',
  'REFUND',
  'FEATURE',
  'OTHER',
]);

const PRIORITIES: ReadonlySet<TicketPriority> = new Set([
  'URGENT',
  'HIGH',
  'NORMAL',
  'LOW',
]);

const STATUSES: ReadonlySet<TicketStatus> = new Set([
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
]);

/**
 * Allowed status transitions (admin). User-side is more restrictive
 * (handled in user-facing methods) — users cannot mutate status directly.
 */
const STATUS_TRANSITIONS: Record<TicketStatus, ReadonlySet<TicketStatus>> = {
  OPEN: new Set(['IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  IN_PROGRESS: new Set(['RESOLVED', 'CLOSED', 'OPEN']),
  RESOLVED: new Set(['CLOSED', 'IN_PROGRESS']),
  // CLOSED cannot go back to OPEN — re-open path is via IN_PROGRESS only.
  CLOSED: new Set(['IN_PROGRESS']),
};

/**
 * SLA hours per priority. Used by BullMQ ticket-sla scan.
 */
export const SLA_HOURS: Record<TicketPriority, number> = {
  URGENT: 1,
  HIGH: 4,
  NORMAL: 24,
  LOW: 72,
};

export interface CreateTicketInput {
  userId: string;
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  initialContent?: string;
  /**
   * If provided, the initial message is authored as ADMIN (运营代用户提单).
   * Otherwise the initial message is authored as USER.
   */
  asAdminId?: string;
}

export interface ListFilters {
  page: number;
  pageSize: number;
  search?: string;
  category?: TicketCategory;
  priority?: TicketPriority;
  status?: TicketStatus;
  assigneeId?: string;
  userId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

export type TicketDto = Ticket;

export interface TicketDetail {
  ticket: TicketDto;
  messages: TicketMessageDto[];
  user: {
    id: string;
    email: string | null;
    nickname: string;
    plan?: string;
    totalSpent?: number;
    recentOrders?: Array<{ id: string; amount: number; createdAt: Date }>;
  } | null;
}

export type TicketMessageDto = Omit<TicketMessage, 'attachments'> & {
  attachments: string[];
};

export interface ListResult {
  items: TicketDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ------------------------------ ticketNumber -----------------------

  /**
   * Generate `TKT-YYYYMMDD-NNNNN` using Redis INCR. If Redis is unavailable
   * (network issue, transient failure), fall back to a UUID-based
   * `TKT-YYYYMMDD-FBxxxxxx` so the create request still succeeds. The
   * downstream DB unique constraint catches any collision.
   */
  async generateTicketNumber(): Promise<string> {
    const day = this.formatDay(new Date());
    const counterKey = `ticket:counter:${day}`;
    try {
      const n = await this.redis.incr(counterKey);
      // 2-day TTL keeps the counter alive across midnight rollovers and
      // any short clock drift. We don't rely on it for correctness — the
      // DB unique constraint is the real guarantor.
      await this.redis.expire(counterKey, 86400 * 2);
      return `TKT-${day}-${String(n).padStart(5, '0')}`;
    } catch (err) {
      this.logger.warn(
        `redis incr failed, using fallback ticketNumber: ${(err as Error).message}`,
      );
      const fallback = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
      return `TKT-${day}-FB${fallback}`;
    }
  }

  private formatDay(d: Date): string {
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = d.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  // ------------------------------ CRUD --------------------------------

  async list(filters: ListFilters): Promise<ListResult> {
    const where: Prisma.TicketWhereInput = {};
    if (filters.search) {
      const s = filters.search.trim();
      where.OR = [
        { subject: { contains: s, mode: 'insensitive' } },
        { ticketNumber: { contains: s, mode: 'insensitive' } },
        { user: { email: { contains: s, mode: 'insensitive' } } },
      ];
    }
    if (filters.category) where.category = filters.category;
    if (filters.priority) where.priority = filters.priority;
    if (filters.status) where.status = filters.status;
    if (filters.assigneeId) {
      if (filters.assigneeId === 'unassigned') {
        where.assigneeId = null;
      } else {
        where.assigneeId = filters.assigneeId;
      }
    }
    if (filters.userId) where.userId = filters.userId;
    if (filters.createdFrom || filters.createdTo) {
      where.createdAt = {
        ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
        ...(filters.createdTo ? { lte: filters.createdTo } : {}),
      };
    }

    const page = Math.max(filters.page, 1);
    const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);

    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async create(input: CreateTicketInput): Promise<TicketDto> {
    if (!input.userId) throw new BadRequestException('userId 必填');
    if (typeof input.subject !== 'string' || !input.subject.trim()) {
      throw new BadRequestException('subject 必填');
    }
    if (input.subject.length > SUBJECT_MAX) {
      throw new BadRequestException(`subject 长度 ≤ ${SUBJECT_MAX} 字符`);
    }
    if (!CATEGORIES.has(input.category)) {
      throw new BadRequestException('category 非法');
    }
    if (input.priority && !PRIORITIES.has(input.priority)) {
      throw new BadRequestException('priority 非法');
    }
    if (
      input.initialContent !== undefined &&
      input.initialContent !== null &&
      typeof input.initialContent !== 'string'
    ) {
      throw new BadRequestException('initialContent 类型非法');
    }
    if (input.initialContent && input.initialContent.length > CONTENT_MAX) {
      throw new BadRequestException(`initialContent 长度 ≤ ${CONTENT_MAX} 字符`);
    }

    const userExists = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!userExists) throw new BadRequestException('userId 不存在');

    const ticketNumber = await this.generateTicketNumber();

    const ticket = await this.prisma.ticket.create({
      data: {
        ticketNumber,
        userId: input.userId,
        subject: input.subject.trim(),
        category: input.category,
        priority: input.priority ?? 'NORMAL',
        status: 'OPEN',
      },
    });

    if (input.initialContent && input.initialContent.trim()) {
      await this.prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: input.asAdminId ? 'ADMIN' : 'USER',
          authorId: input.asAdminId ?? input.userId,
          content: input.initialContent.trim(),
          attachments: '[]',
          isInternal: false,
        },
      });
    }

    return ticket;
  }

  async getDetail(
    id: string,
    options: { includeInternal: boolean; userId?: string },
  ): Promise<TicketDetail> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, nickname: true } },
      },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (options.userId && ticket.userId !== options.userId) {
      throw new ForbiddenException('无权访问此工单');
    }

    const where: Prisma.TicketMessageWhereInput = { ticketId: id };
    if (!options.includeInternal) {
      where.isInternal = false;
    }
    const [messages, activeSub, paidAgg, recentOrders] = await Promise.all([
      this.prisma.ticketMessage.findMany({
        where,
        orderBy: { createdAt: 'asc' },
      }),
      ticket.user
        ? this.prisma.subscriptionPeriod.findFirst({
            where: {
              userId: ticket.user.id,
              status: 'ACTIVE',
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            include: { plan: { select: { name: true } } },
            orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
          })
        : Promise.resolve(null),
      ticket.user
        ? this.prisma.order.aggregate({
            where: {
              userId: ticket.user.id,
              status: { in: ['PAID', 'COMPLETED'] },
            },
            _sum: { amountCents: true },
          })
        : Promise.resolve({ _sum: { amountCents: 0 } }),
      ticket.user
        ? this.prisma.order.findMany({
            where: { userId: ticket.user.id },
            select: { id: true, amountCents: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : Promise.resolve([]),
    ]);

    return {
      ticket,
      messages: messages.map((m) => this.toMessageDto(m)),
      user: ticket.user
        ? {
            id: ticket.user.id,
            email: ticket.user.email,
            nickname: ticket.user.nickname,
            plan: activeSub?.plan.name,
            totalSpent: (paidAgg._sum.amountCents ?? 0) / 100,
            recentOrders: recentOrders.map((o) => ({
              id: o.id,
              amount: o.amountCents / 100,
              createdAt: o.createdAt,
            })),
          }
        : null,
    };
  }

  // ------------------------------ messages ---------------------------

  async addMessage(
    id: string,
    input: {
      authorType: TicketAuthorType;
      authorId: string;
      content: string;
      isInternal?: boolean;
      attachments?: string[];
    },
  ): Promise<TicketMessageDto> {
    if (typeof input.content !== 'string' || !input.content.trim()) {
      throw new BadRequestException('content 必填');
    }
    if (input.content.length > CONTENT_MAX) {
      throw new BadRequestException(`content 长度 ≤ ${CONTENT_MAX} 字符`);
    }
    const attachments = this.normalizeAttachments(input.attachments);

    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, status: true, userId: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');

    // USER cannot reply to a CLOSED ticket. ADMIN can (e.g. follow-up note),
    // and replying as ADMIN auto-reopens to IN_PROGRESS unless internal.
    if (input.authorType === 'USER' && ticket.status === 'CLOSED') {
      throw new BadRequestException(
        '工单已关闭，无法回复。如需继续请联系客服重新打开',
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: input.authorType,
          authorId: input.authorId,
          content: input.content.trim(),
          attachments: JSON.stringify(attachments),
          isInternal: input.isInternal ?? false,
        },
      });

      // Auto-progress status when an admin replies to an OPEN ticket
      // (visible reply only — internal notes don't move status).
      if (
        input.authorType === 'ADMIN' &&
        !msg.isInternal &&
        ticket.status === 'OPEN'
      ) {
        await tx.ticket.update({
          where: { id },
          data: { status: 'IN_PROGRESS' },
        });
      }
      // User replied on a RESOLVED ticket → they didn't accept the resolution.
      // Re-open back to IN_PROGRESS and clear resolvedAt so SLA / lifecycle
      // metrics reflect that the ticket is active again. Internal notes don't
      // count (USER cannot author internal anyway, but keep the guard explicit).
      else if (
        input.authorType === 'USER' &&
        !msg.isInternal &&
        ticket.status === 'RESOLVED'
      ) {
        await tx.ticket.update({
          where: { id },
          data: { status: 'IN_PROGRESS', resolvedAt: null },
        });
      }
      // Bump updatedAt for sorting even when status didn't change.
      await tx.ticket.update({
        where: { id },
        data: { updatedAt: new Date() },
      });

      return msg;
    });

    return this.toMessageDto(created);
  }

  // ------------------------------ status / mutators ------------------

  async changeStatus(
    id: string,
    next: TicketStatus,
    actorAdminId: string,
  ): Promise<TicketDto> {
    if (!STATUSES.has(next)) throw new BadRequestException('status 非法');
    const current = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, status: true, ticketNumber: true },
    });
    if (!current) throw new NotFoundException('工单不存在');
    if (current.status === next) {
      return this.prisma.ticket.findUniqueOrThrow({ where: { id } });
    }
    const allowed = STATUS_TRANSITIONS[current.status];
    if (!allowed.has(next)) {
      throw new BadRequestException(
        `状态不允许从 ${current.status} → ${next}`,
      );
    }

    const data: Prisma.TicketUpdateInput = { status: next };
    if (next === 'RESOLVED') data.resolvedAt = new Date();
    if (next === 'CLOSED') data.closedAt = new Date();
    // Reopen path: clear resolvedAt/closedAt so SLA + lifecycle metrics make sense.
    if (
      (current.status === 'CLOSED' || current.status === 'RESOLVED') &&
      next === 'IN_PROGRESS'
    ) {
      data.resolvedAt = null;
      data.closedAt = null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.update({ where: { id }, data });
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: 'SYSTEM',
          authorId: actorAdminId,
          content: `状态: ${current.status} → ${next}`,
          attachments: '[]',
          isInternal: true,
        },
      });
      return t;
    });
    return updated;
  }

  async assign(
    id: string,
    assigneeId: string | null,
    actorAdminId: string,
  ): Promise<TicketDto> {
    const current = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, assigneeId: true },
    });
    if (!current) throw new NotFoundException('工单不存在');
    const trimmed = assigneeId?.trim() || null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.update({
        where: { id },
        data: { assigneeId: trimmed },
      });
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: 'SYSTEM',
          authorId: actorAdminId,
          content: trimmed
            ? `分配给: ${trimmed}`
            : `取消分配 (原: ${current.assigneeId ?? '未分配'})`,
          attachments: '[]',
          isInternal: true,
        },
      });
      return t;
    });
    return updated;
  }

  async changeCategory(
    id: string,
    category: TicketCategory,
    actorAdminId: string,
  ): Promise<TicketDto> {
    if (!CATEGORIES.has(category)) {
      throw new BadRequestException('category 非法');
    }
    const current = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, category: true },
    });
    if (!current) throw new NotFoundException('工单不存在');
    if (current.category === category) {
      return this.prisma.ticket.findUniqueOrThrow({ where: { id } });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.update({ where: { id }, data: { category } });
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: 'SYSTEM',
          authorId: actorAdminId,
          content: `分类: ${current.category} → ${category}`,
          attachments: '[]',
          isInternal: true,
        },
      });
      return t;
    });
    return updated;
  }

  async changePriority(
    id: string,
    priority: TicketPriority,
    actorAdminId: string,
  ): Promise<TicketDto> {
    if (!PRIORITIES.has(priority)) {
      throw new BadRequestException('priority 非法');
    }
    const current = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, priority: true },
    });
    if (!current) throw new NotFoundException('工单不存在');
    if (current.priority === priority) {
      return this.prisma.ticket.findUniqueOrThrow({ where: { id } });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const t = await tx.ticket.update({ where: { id }, data: { priority } });
      await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorType: 'SYSTEM',
          authorId: actorAdminId,
          content: `优先级: ${current.priority} → ${priority}`,
          attachments: '[]',
          isInternal: true,
        },
      });
      return t;
    });
    return updated;
  }

  async close(id: string, actorAdminId: string): Promise<TicketDto> {
    return this.changeStatus(id, 'CLOSED', actorAdminId);
  }

  /**
   * Merge `srcId` into `dstId`:
   *   1. Move all messages from src → dst (re-parent ticket_id).
   *   2. Drop a SYSTEM message in dst noting the merge (with src ticketNumber).
   *   3. Drop a SYSTEM message in src (already has its messages re-parented,
   *      so this is just an empty marker — but we re-create it before the
   *      move so it stays attached to src).
   *   4. Mark src CLOSED with closedAt = now.
   *
   * If src === dst, throw. If either doesn't exist, throw.
   */
  async merge(
    srcId: string,
    dstId: string,
    actorAdminId: string,
  ): Promise<{ src: TicketDto; dst: TicketDto }> {
    if (!srcId || !dstId) throw new BadRequestException('srcId/dstId 必填');
    if (srcId === dstId) {
      throw new BadRequestException('不能合并到自身');
    }
    const [src, dst] = await Promise.all([
      this.prisma.ticket.findUnique({ where: { id: srcId } }),
      this.prisma.ticket.findUnique({ where: { id: dstId } }),
    ]);
    if (!src) throw new NotFoundException('源工单不存在');
    if (!dst) throw new NotFoundException('目标工单不存在');
    // Privacy: merging across users would re-parent one user's messages onto
    // another user's ticket — exposing private conversation. Block hard.
    if (src.userId !== dst.userId) {
      throw new BadRequestException('不能合并不同用户的工单');
    }
    if (src.status === 'CLOSED') {
      throw new BadRequestException('源工单已关闭，无法合并');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Audit messages first — they stay with their original ticket because
      // they're created BEFORE the re-parent step, but we still want one in dst
      // and one in src. We create the src marker first, then re-parent EVERY
      // message after that point — so we leave the src marker alone by NOT
      // moving it (filter on createdAt cutoff).
      //
      // Simpler approach: re-parent everything that already exists, then add
      // the markers in their respective tickets.

      // Re-parent existing messages from src → dst
      await tx.ticketMessage.updateMany({
        where: { ticketId: srcId },
        data: { ticketId: dstId },
      });

      // Marker in dst
      await tx.ticketMessage.create({
        data: {
          ticketId: dstId,
          authorType: 'SYSTEM',
          authorId: actorAdminId,
          content: `合并自工单 ${src.ticketNumber} (${src.subject})`,
          attachments: '[]',
          isInternal: true,
        },
      });

      // Marker in src — kept so the closed src still has a trail
      await tx.ticketMessage.create({
        data: {
          ticketId: srcId,
          authorType: 'SYSTEM',
          authorId: actorAdminId,
          content: `已合并到工单 ${dst.ticketNumber} (${dst.subject})。原对话已移动。`,
          attachments: '[]',
          isInternal: true,
        },
      });

      const updatedSrc = await tx.ticket.update({
        where: { id: srcId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      const updatedDst = await tx.ticket.update({
        where: { id: dstId },
        data: { updatedAt: new Date() },
      });

      return { src: updatedSrc, dst: updatedDst };
    });

    return result;
  }

  // ------------------------------ user-side --------------------------

  async listForUser(
    userId: string,
    page: number,
    pageSize: number,
    status?: TicketStatus,
  ): Promise<ListResult> {
    return this.list({
      page,
      pageSize,
      userId,
      status,
    });
  }

  async getDetailForUser(id: string, userId: string): Promise<TicketDetail> {
    return this.getDetail(id, { includeInternal: false, userId });
  }

  async createForUser(
    userId: string,
    body: { subject: string; category: TicketCategory; content?: string; priority?: TicketPriority },
  ): Promise<TicketDto> {
    return this.create({
      userId,
      subject: body.subject,
      category: body.category,
      priority: body.priority,
      initialContent: body.content,
    });
  }

  async replyForUser(
    id: string,
    userId: string,
    content: string,
    attachments?: string[],
  ): Promise<TicketMessageDto> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    });
    if (!ticket) throw new NotFoundException('工单不存在');
    if (ticket.userId !== userId) {
      throw new ForbiddenException('无权回复此工单');
    }
    return this.addMessage(id, {
      authorType: 'USER',
      authorId: userId,
      content,
      isInternal: false,
      attachments,
    });
  }

  // ------------------------------ SLA scan ---------------------------

  /**
   * Scan all OPEN/IN_PROGRESS tickets per priority and emit an alert for those
   * past SLA. Dedup window: 24h — if an alert was already emitted for this
   * ticketId in the last day, skip it. Alerts are written to AlertEvent because
   * billing no longer owns admin activity logs.
   */
  async checkSla(): Promise<{
    scanned: number;
    overdue: number;
    alerted: number;
  }> {
    const now = Date.now();
    let scanned = 0;
    let overdue = 0;
    let alerted = 0;

    for (const [priority, hours] of Object.entries(SLA_HOURS) as Array<
      [TicketPriority, number]
    >) {
      const cutoff = new Date(now - hours * 3_600_000);
      const candidates = await this.prisma.ticket.findMany({
        where: {
          priority,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          createdAt: { lt: cutoff },
        },
        select: {
          id: true,
          ticketNumber: true,
          priority: true,
          status: true,
          createdAt: true,
        },
      });
      scanned += candidates.length;
      overdue += candidates.length;

      for (const t of candidates) {
        const dedupSince = new Date(now - 86400_000);
        const recent = await this.prisma.alertEvent.findFirst({
          where: {
            category: 'SYSTEM',
            sourceType: 'ticket.sla.overdue',
            sourceId: t.id,
            createdAt: { gt: dedupSince },
          },
          select: { id: true },
        });
        if (recent) continue;

        const ageHours = Math.floor(
          (now - t.createdAt.getTime()) / 3_600_000,
        );
        try {
          await this.prisma.alertEvent.create({
            data: {
              category: 'SYSTEM',
              severity: this.slaAlertSeverity(t.priority),
              title: `工单 SLA 超时: ${t.ticketNumber}`,
              message: `${t.priority} 工单已等待 ${ageHours} 小时，超过 ${hours} 小时 SLA`,
              sourceType: 'ticket.sla.overdue',
              sourceId: t.id,
              context: JSON.stringify({
                ticketId: t.id,
                ticketNumber: t.ticketNumber,
                priority: t.priority,
                status: t.status,
                slaHours: hours,
                ageHours,
              }),
            },
          });
          alerted += 1;
          this.logger.warn(
            `SLA overdue: ticket=${t.ticketNumber} priority=${t.priority} ageH=${ageHours} sla=${hours}`,
          );
        } catch (err) {
          this.logger.error(
            `failed to log SLA alert for ticket=${t.id}: ${(err as Error).message}`,
          );
        }
      }
    }

    return { scanned, overdue, alerted };
  }

  private slaAlertSeverity(priority: TicketPriority): AlertEventSeverity {
    if (priority === 'URGENT') return 'CRITICAL';
    if (priority === 'HIGH') return 'HIGH';
    if (priority === 'NORMAL') return 'MEDIUM';
    return 'LOW';
  }

  // ------------------------------ helpers ----------------------------

  private toMessageDto(m: TicketMessage): TicketMessageDto {
    let attachments: string[] = [];
    try {
      const parsed = JSON.parse(m.attachments);
      if (Array.isArray(parsed)) {
        attachments = parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      // malformed — surface as empty rather than crash the response
      attachments = [];
    }
    return { ...m, attachments };
  }

  private normalizeAttachments(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new BadRequestException('attachments 必须是数组');
    }
    if (raw.length > ATTACHMENT_MAX) {
      throw new BadRequestException(`attachments 数量 ≤ ${ATTACHMENT_MAX}`);
    }
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v !== 'string' || !v.trim()) {
        throw new BadRequestException('attachments 元素必须是非空字符串');
      }
      if (v.length > ATTACHMENT_URL_MAX) {
        throw new BadRequestException(
          `attachments 元素长度 ≤ ${ATTACHMENT_URL_MAX}`,
        );
      }
      out.push(v.trim());
    }
    return out;
  }
}
