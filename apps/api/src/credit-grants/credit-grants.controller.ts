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
import {
  GrantExpirePolicy,
  GrantNotifyType,
  GrantRewardType,
  GrantTriggerType,
} from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { CreditGrantExecutor } from './credit-grant-executor';
import {
  CreateGrantRuleInput,
  CreditGrantsService,
  UpdateGrantRuleInput,
} from './credit-grants.service';

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

function parseTriggerType(raw: string | undefined): GrantTriggerType | undefined {
  if (
    raw === 'DAILY_CRON' ||
    raw === 'FIRST_LOGIN' ||
    raw === 'DAILY_CHECKIN' ||
    raw === 'TASK_COMPLETE' ||
    raw === 'WEEKLY_CRON'
  ) {
    return raw;
  }
  return undefined;
}

interface GrantRuleBody {
  name?: string;
  triggerType?: GrantTriggerType;
  cronExpr?: string | null;
  segmentId?: string | null;
  rewardType?: GrantRewardType;
  rewardAmount?: number;
  productId?: string | null;
  expirePolicy?: GrantExpirePolicy;
  expireDays?: number | null;
  perUserLimit?: number;
  globalDailyCap?: number | null;
  isActive?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  notifyType?: GrantNotifyType | null;
  notifyTemplate?: string | null;
}

@ApiTags('AdminV2 / GrantRules')
@Controller('admin/v2/grant-rules')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class CreditGrantsController {
  constructor(
    private readonly service: CreditGrantsService,
    private readonly executor: CreditGrantExecutor,
  ) {}

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Get()
  async list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      search?: string;
      triggerType?: string;
      isActive?: string;
      segmentId?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.list({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
      search: query.search?.trim() || undefined,
      triggerType: parseTriggerType(query.triggerType),
      isActive: parseBoolean(query.isActive),
      segmentId: query.segmentId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Post()
  async create(@Body() body: GrantRuleBody): Promise<ApiResponse<unknown>> {
    if (!body?.name) throw new BadRequestException('name 必填');
    if (!body.triggerType) throw new BadRequestException('triggerType 必填');
    if (!body.rewardType) throw new BadRequestException('rewardType 必填');
    if (typeof body.rewardAmount !== 'number') {
      throw new BadRequestException('rewardAmount 必填');
    }
    if (!body.expirePolicy) throw new BadRequestException('expirePolicy 必填');

    const input: CreateGrantRuleInput = {
      name: body.name,
      triggerType: body.triggerType,
      cronExpr: body.cronExpr ?? null,
      segmentId: body.segmentId ?? null,
      rewardType: body.rewardType,
      rewardAmount: body.rewardAmount,
      productId: body.productId ?? null,
      expirePolicy: body.expirePolicy,
      expireDays: body.expireDays ?? null,
      perUserLimit: body.perUserLimit ?? 1,
      globalDailyCap: body.globalDailyCap ?? null,
      isActive: body.isActive ?? true,
      startAt: body.startAt ?? null,
      endAt: body.endAt ?? null,
      notifyType: body.notifyType ?? null,
      notifyTemplate: body.notifyTemplate ?? null,
    };
    const data = await this.service.create(input);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: GrantRuleBody,
  ): Promise<ApiResponse<unknown>> {
    const input: UpdateGrantRuleInput = {
      ...body,
    };
    const data = await this.service.update(id, input);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.service.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Post(':id/preview')
  async preview(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.preview(id);
    return { code: 0, message: 'ok', data };
  }

  // The frontend stub uses `/trigger`; spec calls it `/manual-trigger`.
  // Expose both for forward compatibility.
  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Post(':id/manual-trigger')
  async manualTrigger(
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    const rule = await this.service.getById(id);
    const result = await this.executor.executeRule(rule, {
      manualTrigger: true,
    });
    return { code: 0, message: '已触发', data: result };
  }

  @RequireAdminPermission('admin.page.grant_rules.manage')
  @Post(':id/trigger')
  async triggerAlias(
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    return this.manualTrigger(id);
  }

  @RequireAdminPermission('admin.page.grant_rules.view')
  @Get(':id/redemptions')
  async listRedemptions(
    @Param('id') id: string,
    @Query() query: { page?: string; pageSize?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.listRedemptions(
      id,
      parseInteger(query.page, 1),
      parseInteger(query.pageSize, 20),
    );
    return { code: 0, message: 'ok', data };
  }
}
