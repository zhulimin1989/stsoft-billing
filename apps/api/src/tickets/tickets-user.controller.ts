/**
 * User-facing ticket controller. Mounts at /api/v1/tickets via NestJS URI
 * versioning (the global prefix is `api`, the version prefix is `v`, so a
 * controller declared as `{ path: 'tickets', version: '1' }` ends up at
 * `/api/v1/tickets`).
 *
 * Auth is enforced by the billing runtime's global guard. Every
 * read filters by the JWT-derived userId so users cannot see anyone else's
 * tickets, and every internal note (`isInternal=true`) is stripped from the
 * detail payload.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TicketCategory, TicketPriority, TicketStatus } from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TicketsService } from './tickets.service';

const CATEGORIES = new Set<TicketCategory>([
  'BILLING',
  'TECHNICAL',
  'REFUND',
  'FEATURE',
  'OTHER',
]);
const PRIORITIES = new Set<TicketPriority>(['URGENT', 'HIGH', 'NORMAL', 'LOW']);
const STATUSES = new Set<TicketStatus>([
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
]);

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

@ApiTags('Tickets / User')
@Controller({ path: 'tickets', version: '1' })
export class TicketsUserController {
  constructor(private readonly service: TicketsService) {}

  @Get()
  async list(
    @CurrentUser('id') userId: string,
    @Query() query: { page?: string; pageSize?: string; status?: string },
  ): Promise<ApiResponse<unknown>> {
    if (!userId) throw new BadRequestException('未登录');
    const status =
      query.status && STATUSES.has(query.status as TicketStatus)
        ? (query.status as TicketStatus)
        : undefined;
    const data = await this.service.listForUser(
      userId,
      parseInteger(query.page, 1),
      parseInteger(query.pageSize, 20),
      status,
    );
    return { code: 0, message: 'ok', data };
  }

  @Post()
  async create(
    @CurrentUser('id') userId: string,
    @Body()
    body: {
      subject?: string;
      category?: TicketCategory;
      priority?: TicketPriority;
      content?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    if (!userId) throw new BadRequestException('未登录');
    if (!body?.subject) throw new BadRequestException('subject 必填');
    if (!body.category) throw new BadRequestException('category 必填');
    if (!CATEGORIES.has(body.category)) {
      throw new BadRequestException('category 非法');
    }
    if (body.priority && !PRIORITIES.has(body.priority)) {
      throw new BadRequestException('priority 非法');
    }
    const data = await this.service.createForUser(userId, {
      subject: body.subject,
      category: body.category,
      priority: body.priority,
      content: body.content,
    });
    return { code: 0, message: '创建成功', data };
  }

  @Get(':id')
  async detail(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    if (!userId) throw new BadRequestException('未登录');
    const data = await this.service.getDetailForUser(id, userId);
    return { code: 0, message: 'ok', data };
  }

  @Post(':id/messages')
  async reply(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() body: { content?: string; attachments?: string[] },
  ): Promise<ApiResponse<unknown>> {
    if (!userId) throw new BadRequestException('未登录');
    if (!body?.content) throw new BadRequestException('content 必填');
    const data = await this.service.replyForUser(
      id,
      userId,
      body.content,
      body.attachments,
    );
    return { code: 0, message: '已回复', data };
  }
}
