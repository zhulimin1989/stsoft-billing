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
import { ApiResponse } from '@ruidong/shared';
import { RechargeBonusType } from '@prisma/client';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { RechargeTiersService } from './recharge-tiers.service';

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

interface RechargeTierBody {
  productId?: string;
  amountCents?: number;
  bonusType?: RechargeBonusType;
  bonusValue?: number;
  badge?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  startAt?: string | null;
  endAt?: string | null;
}

@ApiTags('AdminV2 / RechargeTiers')
@Controller('admin/v2/recharge-tiers')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class RechargeTiersController {
  constructor(private readonly service: RechargeTiersService) {}

  @RequireAdminPermission('admin.page.recharge_tiers.view')
  @Get()
  async list(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      productId?: string;
      isActive?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.list({
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
      productId: query.productId?.trim() || undefined,
      isActive: parseBoolean(query.isActive),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Post()
  async create(
    @Body() body: RechargeTierBody,
  ): Promise<ApiResponse<unknown>> {
    if (!body?.productId) throw new BadRequestException('productId 必填');
    if (typeof body.amountCents !== 'number') {
      throw new BadRequestException('amountCents 必填');
    }
    if (!body.bonusType) throw new BadRequestException('bonusType 必填');
    if (typeof body.bonusValue !== 'number') {
      throw new BadRequestException('bonusValue 必填');
    }
    const data = await this.service.create({
      productId: body.productId,
      amountCents: body.amountCents,
      bonusType: body.bonusType,
      bonusValue: body.bonusValue,
      badge: body.badge ?? null,
      sortOrder: body.sortOrder,
      isActive: body.isActive,
      startAt: body.startAt ?? null,
      endAt: body.endAt ?? null,
    });
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.view')
  @Get(':id')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.getById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: RechargeTierBody,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.update(id, {
      productId: body.productId,
      amountCents: body.amountCents,
      bonusType: body.bonusType,
      bonusValue: body.bonusValue,
      badge: body.badge,
      sortOrder: body.sortOrder,
      isActive: body.isActive,
      startAt: body.startAt,
      endAt: body.endAt,
    });
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<ApiResponse<null>> {
    await this.service.softDelete(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.page.recharge_tiers.manage')
  @Post(':id/clone')
  async clone(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.service.clone(id);
    return { code: 0, message: '已复制', data };
  }
}
