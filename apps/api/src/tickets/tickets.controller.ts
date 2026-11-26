/**
 * Admin-facing ticket controller. Mounts at /admin/v2/tickets.
 *
 * Permission model:
 *   - All read endpoints require `admin.page.tickets.view`.
 *   - All write endpoints require `admin.page.tickets.manage` (which implies view).
 *
 * The user-facing surface lives in `tickets-user.controller.ts` and is mounted
 * at `/api/v1/tickets` via NestJS URI versioning.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
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

function asCategory(raw: string | undefined): TicketCategory | undefined {
  return raw && CATEGORIES.has(raw as TicketCategory)
    ? (raw as TicketCategory)
    : undefined;
}
function asPriority(raw: string | undefined): TicketPriority | undefined {
  return raw && PRIORITIES.has(raw as TicketPriority)
    ? (raw as TicketPriority)
    : undefined;
}
function asStatus(raw: string | undefined): TicketStatus | undefined {
  return raw && STATUSES.has(raw as TicketStatus)
    ? (raw as TicketStatus)
    : undefined;
}

function asDate(raw: string | undefined, endOfDay = false): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    date.setHours(23, 59, 59, 999);
  }
  return date;
}

@ApiTags('AdminV2 / Tickets')
@Controller('admin/v2/tickets')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class TicketsController {
  constructor(private readonly service: TicketsService) {}

  @RequireAdminPermission('admin.page.tickets.view')
  @Get()
  async list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      search?: string;
      category?: string;
      priority?: string;
      status?: string;
      assigneeId?: string;
      userId?: string;
      createdFrom?: string;
      createdTo?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.list({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
      search: query.search?.trim() || undefined,
      category: asCategory(query.category),
      priority: asPriority(query.priority),
      status: asStatus(query.status),
      assigneeId: query.assigneeId?.trim() || undefined,
      userId: query.userId?.trim() || undefined,
      createdFrom: asDate(query.createdFrom),
      createdTo: asDate(query.createdTo, true),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Post()
  async create(
    @CurrentUser('id') adminId: string,
    @Body()
    body: {
      userId?: string;
      subject?: string;
      category?: TicketCategory;
      priority?: TicketPriority;
      content?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.userId) throw new BadRequestException('userId 必填');
    if (!body.subject) throw new BadRequestException('subject 必填');
    if (!body.category) throw new BadRequestException('category 必填');
    if (!CATEGORIES.has(body.category)) {
      throw new BadRequestException('category 非法');
    }
    if (body.priority && !PRIORITIES.has(body.priority)) {
      throw new BadRequestException('priority 非法');
    }
    const data = await this.service.create({
      userId: body.userId,
      subject: body.subject,
      category: body.category,
      priority: body.priority,
      initialContent: body.content,
      asAdminId: adminId,
    });
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.tickets.view')
  @Get(':id')
  async detail(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getDetail(id, { includeInternal: true });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Post(':id/messages')
  async reply(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body()
    body: {
      content?: string;
      isInternal?: boolean;
      attachments?: string[];
    },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.content) throw new BadRequestException('content 必填');
    const data = await this.service.addMessage(id, {
      authorType: 'ADMIN',
      authorId: adminId,
      content: body.content,
      isInternal: !!body.isInternal,
      attachments: body.attachments,
    });
    return { code: 0, message: '已回复', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Patch(':id/status')
  async changeStatus(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { status?: TicketStatus },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.status) throw new BadRequestException('status 必填');
    if (!STATUSES.has(body.status)) {
      throw new BadRequestException('status 非法');
    }
    const data = await this.service.changeStatus(id, body.status, adminId);
    return { code: 0, message: '已更新', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Patch(':id/assign')
  async assign(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { assigneeId?: string | null },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.assign(
      id,
      body?.assigneeId ?? null,
      adminId,
    );
    return { code: 0, message: '已分配', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Patch(':id/category')
  async changeCategory(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { category?: TicketCategory },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.category) throw new BadRequestException('category 必填');
    if (!CATEGORIES.has(body.category)) {
      throw new BadRequestException('category 非法');
    }
    const data = await this.service.changeCategory(id, body.category, adminId);
    return { code: 0, message: '已更新', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Patch(':id/priority')
  async changePriority(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { priority?: TicketPriority },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.priority) throw new BadRequestException('priority 必填');
    if (!PRIORITIES.has(body.priority)) {
      throw new BadRequestException('priority 非法');
    }
    const data = await this.service.changePriority(id, body.priority, adminId);
    return { code: 0, message: '已更新', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Post(':id/close')
  async close(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.close(id, adminId);
    return { code: 0, message: '已关闭', data };
  }

  @RequireAdminPermission('admin.page.tickets.manage')
  @Post(':id/merge')
  async merge(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { targetId?: string },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.targetId) throw new BadRequestException('targetId 必填');
    const data = await this.service.merge(id, body.targetId, adminId);
    return { code: 0, message: '已合并', data };
  }
}
