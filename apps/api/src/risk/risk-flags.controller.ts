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
import { RiskFlagStatus, RiskRuleType, RiskSeverity } from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { RiskFlagsService } from './risk-flags.service';

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RULE_TYPES: ReadonlySet<RiskRuleType> = new Set([
  'BLACKLIST',
  'USAGE_THRESHOLD',
  'IP_LIMIT',
  'REFUND_RATE',
  'FRAUD_PROVIDER',
]);
const SEVERITIES: ReadonlySet<RiskSeverity> = new Set([
  'HIGH',
  'MEDIUM',
  'LOW',
]);
const STATUSES: ReadonlySet<RiskFlagStatus> = new Set([
  'PENDING',
  'CONFIRMED',
  'RELEASED',
  'PERMANENT_BAN',
]);

function asEnum<T extends string>(
  raw: string | undefined,
  set: ReadonlySet<T>,
): T | undefined {
  return raw && set.has(raw as T) ? (raw as T) : undefined;
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

@ApiTags('AdminV2 / RiskUsers')
@Controller('admin/v2/risk-users')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class RiskFlagsController {
  constructor(private readonly service: RiskFlagsService) {}

  @RequireAdminPermission('admin.page.risk_users.view')
  @Get()
  async list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      search?: string;
      ruleType?: string;
      severity?: string;
      status?: string;
      userId?: string;
      triggeredFrom?: string;
      triggeredTo?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.list({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
      search: query.search?.trim() || undefined,
      ruleType: asEnum(query.ruleType, RULE_TYPES),
      severity: asEnum(query.severity, SEVERITIES),
      status: asEnum(query.status, STATUSES),
      userId: query.userId?.trim() || undefined,
      triggeredFrom: asDate(query.triggeredFrom),
      triggeredTo: asDate(query.triggeredTo, true),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_users.view')
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_users.view')
  @Get(':id/related')
  async related(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.related(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_users.view')
  @Get(':id/history')
  async history(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.history(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_users.view')
  @Get(':id/audit-logs')
  async auditLogs(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.auditLogs(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_users.manage')
  @Post(':id/release')
  async release(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { note?: string },
  ): Promise<ApiResponse<unknown>> {
    const note = (body?.note ?? '').toString().trim();
    if (!note) throw new BadRequestException('note 必填');
    const data = await this.service.release(id, adminId, note);
    return { code: 0, message: '已解封', data };
  }

  @RequireAdminPermission('admin.page.risk_users.manage')
  @Post(':id/ban')
  async ban(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ): Promise<ApiResponse<unknown>> {
    const reason = (body?.reason ?? '').toString().trim();
    if (!reason) throw new BadRequestException('reason 必填');
    const data = await this.service.permanentBan(id, adminId, reason);
    return { code: 0, message: '已永久封禁', data };
  }
}
