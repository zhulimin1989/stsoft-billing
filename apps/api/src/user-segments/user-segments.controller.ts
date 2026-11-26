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
import { SegmentRuleType } from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { UserSegmentsService } from './user-segments.service';

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

function parseRuleType(raw: string | undefined): SegmentRuleType | undefined {
  if (raw === 'STATIC' || raw === 'DYNAMIC') return raw;
  return undefined;
}

@ApiTags('AdminV2 / UserSegments')
@Controller('admin/v2/user-segments')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class UserSegmentsController {
  constructor(private readonly service: UserSegmentsService) {}

  @RequireAdminPermission('admin.catalog.user_segments.view')
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
      pageSize: parseInteger(query.pageSize, 20),
      search: query.search?.trim() || undefined,
      ruleType: parseRuleType(query.ruleType),
      isActive: parseBoolean(query.isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  // NOTE: `preview` must be declared BEFORE `:id` routes — Nest matches on
  // declaration order and otherwise `:id` would swallow `/preview`.
  @RequireAdminPermission('admin.page.user_segments.manage')
  @Post('preview')
  async preview(
    @Body() body: { ruleExpr?: string },
  ): Promise<ApiResponse<unknown>> {
    if (!body?.ruleExpr) throw new BadRequestException('ruleExpr 必填');
    const data = await this.service.preview(body.ruleExpr);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.user_segments.manage')
  @Post()
  async create(
    @Body()
    body: {
      name?: string;
      description?: string;
      ruleType?: SegmentRuleType;
      ruleExpr?: string;
      isActive?: boolean;
    },
  ): Promise<ApiResponse<unknown>> {
    if (!body.name) throw new BadRequestException('name 必填');
    if (!body.ruleType) throw new BadRequestException('ruleType 必填');
    const data = await this.service.create({
      name: body.name,
      description: body.description,
      ruleType: body.ruleType,
      ruleExpr: body.ruleExpr,
      isActive: body.isActive,
    });
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.user_segments.view')
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.user_segments.manage')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      ruleExpr?: string | null;
      isActive?: boolean;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.update(id, body);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.user_segments.manage')
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.service.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.user_segments.manage')
  @Post(':id/refresh')
  async refresh(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.refresh(id);
    return { code: 0, message: '已刷新', data };
  }

  @RequireAdminPermission('admin.page.user_segments.view')
  @Get(':id/members')
  async listMembers(
    @Param('id') id: string,
    @Query() query: { page?: string; pageSize?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.listMembers(
      id,
      parseInteger(query.page, 1),
      parseInteger(query.pageSize, 20),
    );
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.user_segments.manage')
  @Post(':id/members')
  async addMembers(
    @Param('id') id: string,
    @Body() body: { userIds?: string[] },
  ): Promise<ApiResponse<unknown>> {
    if (!Array.isArray(body?.userIds)) {
      throw new BadRequestException('userIds 必填');
    }
    const data = await this.service.addMembers(id, body.userIds);
    return { code: 0, message: '添加完成', data };
  }

  @RequireAdminPermission('admin.page.user_segments.manage')
  @Delete(':id/members/:uid')
  async removeMember(
    @Param('id') id: string,
    @Param('uid') uid: string,
  ): Promise<ApiResponse<null>> {
    await this.service.removeMember(id, uid);
    return { code: 0, message: '已移除', data: null };
  }

  @RequireAdminPermission('admin.page.user_segments.view')
  @Get(':id/references')
  async references(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.references(id);
    return { code: 0, message: 'ok', data };
  }
}
