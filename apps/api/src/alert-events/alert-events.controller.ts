/**
 * AlertEventsController — admin v2 事件流 HTTP 入口。
 *
 * 路由前缀沿用 /admin/v2/alerts(前端 stub `apps/admin/src/api/v2/alerts.ts`
 * 已固定),内部 service / model 命名为 AlertEvent 与既有 v0.3 alerts 表区分。
 *
 * 权限沿用 admin.page.alerts.view / admin.page.alerts.manage,不新增权限原子。
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AlertEventCategory,
  AlertEventSeverity,
  AlertEventStatus,
} from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { AlertEventService } from './alert-events.service';

const CATEGORIES: ReadonlySet<AlertEventCategory> = new Set([
  'PAYMENT',
  'CHANNEL',
  'USAGE',
  'SECURITY',
  'SYSTEM',
]);

const SEVERITIES: ReadonlySet<AlertEventSeverity> = new Set([
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
]);

const STATUSES: ReadonlySet<AlertEventStatus> = new Set([
  'PENDING',
  'READ',
  'HANDLED',
]);

function asEnum<T extends string>(
  raw: string | undefined,
  set: ReadonlySet<T>,
): T | undefined {
  return raw && set.has(raw as T) ? (raw as T) : undefined;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

interface MarkReadBody {
  ids?: string[];
}

interface HandleBody {
  note?: string;
}

@ApiTags('AdminV2 / Alerts')
@Controller('admin/v2/alerts')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class AlertEventsController {
  constructor(private readonly service: AlertEventService) {}

  @RequireAdminPermission('admin.page.alerts.view')
  @Get()
  async list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      category?: string;
      severity?: string;
      status?: string;
      fromDate?: string;
      toDate?: string;
      userId?: string;
      q?: string;
      search?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.list({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
      category: asEnum(query.category, CATEGORIES),
      severity: asEnum(query.severity, SEVERITIES),
      status: asEnum(query.status, STATUSES),
      fromDate: parseDate(query.fromDate),
      toDate: parseDate(query.toDate),
      userId: query.userId?.trim() || undefined,
      // 前端 stub 用 `search`,spec 用 `q`,两者都接受
      q: (query.q ?? query.search)?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.alerts.view')
  @Get('stats')
  async stats(): Promise<ApiResponse<unknown>> {
    const data = await this.service.getStats();
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.alerts.view')
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.alerts.manage')
  @Post('mark-read')
  async markRead(
    @CurrentUser('id') adminId: string,
    @Body() body: MarkReadBody,
  ): Promise<ApiResponse<unknown>> {
    const ids = Array.isArray(body?.ids) ? body!.ids! : null;
    if (!ids || ids.length === 0) {
      throw new BadRequestException('ids 必填且非空');
    }
    const data = await this.service.markRead(ids, adminId);
    return { code: 0, message: '已标记已读', data };
  }

  @RequireAdminPermission('admin.page.alerts.manage')
  @Post(':id/handle')
  async handle(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: HandleBody,
  ): Promise<ApiResponse<unknown>> {
    const note = (body?.note ?? '').toString().trim();
    if (!note) throw new BadRequestException('note 必填');
    const data = await this.service.handle(id, adminId, note);
    return { code: 0, message: '已处理', data };
  }
}
