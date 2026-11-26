import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RiskAction, RiskListType, RiskRuleType } from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { RiskRulesService } from './risk-rules.service';

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBoolean(raw: string | boolean | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

function parseRuleType(raw: string | undefined): RiskRuleType | undefined {
  const allowed = new Set<RiskRuleType>([
    'BLACKLIST',
    'USAGE_THRESHOLD',
    'IP_LIMIT',
    'REFUND_RATE',
    'FRAUD_PROVIDER',
  ]);
  if (raw && allowed.has(raw as RiskRuleType)) return raw as RiskRuleType;
  return undefined;
}

function parseListType(raw: string | undefined): RiskListType | undefined {
  const allowed = new Set<RiskListType>([
    'EMAIL',
    'DOMAIN',
    'IP',
    'CARD_HASH',
    'USER_ID',
  ]);
  if (raw && allowed.has(raw as RiskListType)) return raw as RiskListType;
  return undefined;
}

interface CreateRuleBody {
  name?: string;
  ruleType?: RiskRuleType;
  config?: unknown;
  action?: RiskAction;
  isActive?: boolean;
  confirmDangerousAction?: boolean;
}

interface UpdateRuleBody extends CreateRuleBody {}

const DANGEROUS_ACTIONS: ReadonlySet<RiskAction> = new Set<RiskAction>([
  'BLOCK',
  'FREEZE_USER',
  'DISABLE_KEY',
]);

function assertConfirmedIfDangerous(
  action: RiskAction,
  confirmed: boolean | undefined,
): void {
  if (DANGEROUS_ACTIONS.has(action) && !confirmed) {
    throw new BadRequestException(
      `action=${action} 是危险操作，需在请求体中传 confirmDangerousAction: true 以确认`,
    );
  }
}

interface CreateListEntryBody {
  listType?: RiskListType;
  value?: string;
  reason?: string;
  expiresAt?: string;
  ruleId?: string | null;
}

@ApiTags('AdminV2 / RiskRules')
@Controller('admin/v2/risk-rules')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class RiskRulesController {
  constructor(private readonly service: RiskRulesService) {}

  // ----------- IMPORTANT: list-entries routes must come before /:id ---
  // Order matters in Nest's route resolver: a static segment like
  // /risk-rules/list-entries would otherwise be captured by /:id.

  @RequireAdminPermission('admin.page.risk_rules.view')
  @Get('list-entries')
  async listEntries(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      listType?: string;
      search?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.listEntries({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 50),
      listType: parseListType(query.listType),
      search: query.search?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_rules.manage')
  @Post('list-entries')
  async addEntry(
    @CurrentUser('id') adminId: string,
    @Body() body: CreateListEntryBody,
  ): Promise<ApiResponse<unknown>> {
    if (!body?.listType) throw new BadRequestException('listType 必填');
    if (!body.value) throw new BadRequestException('value 必填');
    const data = await this.service.addEntry({
      listType: body.listType,
      value: body.value,
      reason: body.reason ?? '',
      expiresAt: body.expiresAt ?? null,
      ruleId: body.ruleId ?? null,
      addedBy: adminId,
    });
    return { code: 0, message: '已添加', data };
  }

  @RequireAdminPermission('admin.page.risk_rules.manage')
  @Delete('list-entries/:id')
  async removeEntry(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.service.removeEntry(id);
    return { code: 0, message: '已移除', data: null };
  }

  // ----------- RiskRule CRUD ----------------------------------------

  @RequireAdminPermission('admin.page.risk_rules.view')
  @Get()
  async list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      search?: string;
      ruleType?: string;
      isActive?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.list({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 50),
      search: query.search?.trim() || undefined,
      ruleType: parseRuleType(query.ruleType),
      isActive: parseBoolean(query.isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_rules.manage')
  @Post()
  async create(
    @Body() body: CreateRuleBody,
  ): Promise<ApiResponse<unknown>> {
    if (!body?.name) throw new BadRequestException('name 必填');
    if (!body.ruleType) throw new BadRequestException('ruleType 必填');
    if (body.config === undefined || body.config === null) {
      throw new BadRequestException('config 必填');
    }
    // Server-side default: omitting `action` falls back to ALERT, the safest
    // option (creates an admin flag but doesn't disable keys / freeze users
    // / block requests). Operators must explicitly opt into dangerous
    // actions and confirm with `confirmDangerousAction: true`.
    const action: RiskAction = body.action ?? 'ALERT';
    assertConfirmedIfDangerous(action, body.confirmDangerousAction);
    const data = await this.service.create({
      name: body.name,
      ruleType: body.ruleType,
      action,
      config: body.config,
      isActive: body.isActive ?? true,
    });
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.risk_rules.view')
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.risk_rules.manage')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateRuleBody,
  ): Promise<ApiResponse<unknown>> {
    // If the caller is upgrading the action to a dangerous one, require the
    // same explicit confirmation as create. (Pure-config updates that don't
    // touch action skip this check.)
    if (body.action !== undefined) {
      assertConfirmedIfDangerous(body.action, body.confirmDangerousAction);
    }
    const data = await this.service.update(id, body);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.risk_rules.manage')
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.service.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }
}
