/**
 * ReferralsController — admin v2 邀请裂变 HTTP 入口。
 *
 * 路由前缀 /admin/v2/referrals(前端 stub apps/admin/src/api/v2/referrals.ts 已固定)。
 * 权限沿用 admin.page.referrals.manage(邀请裂变是营销/促销子项,与 Campaign / DiscountCode 同族)。
 *
 * 用户端路由(/api/user/referral-code)在 referrals.user.controller.ts。
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-referrals-design.md
 */
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
import { ReferralRewardCondition } from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import {
  CreateProgramInput,
  ReferralsService,
  UpdateProgramInput,
} from './referrals.service';

interface ProgramBody {
  name?: string;
  inviterReward?: number;
  inviteeReward?: number;
  rewardCondition?: ReferralRewardCondition;
  productId?: string | null;
  trackingOnly?: boolean;
  isActive?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  sameIpLimit?: number | null;
  sameDeviceLimit?: number | null;
  perUserInviteLimit?: number | null;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBooleanQuery(
  raw: string | boolean | undefined,
): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
}

@ApiTags('AdminV2 / Referrals')
@Controller('admin/v2/referrals')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class ReferralsController {
  constructor(private readonly service: ReferralsService) {}

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('programs')
  async listPrograms(): Promise<ApiResponse<unknown>> {
    const items = await this.service.listPrograms();
    return { code: 0, message: 'ok', data: { items } };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Post('programs')
  async createProgram(
    @Body() body: ProgramBody,
  ): Promise<ApiResponse<unknown>> {
    if (
      !body ||
      typeof body.name !== 'string' ||
      body.inviterReward == null ||
      body.inviteeReward == null ||
      !body.rewardCondition
    ) {
      throw new BadRequestException(
        'name / inviterReward / inviteeReward / rewardCondition 必填',
      );
    }
    const data: CreateProgramInput = {
      name: body.name,
      inviterReward: body.inviterReward,
      inviteeReward: body.inviteeReward,
      rewardCondition: body.rewardCondition,
      productId: body.productId ?? null,
      trackingOnly: body.trackingOnly,
      isActive: body.isActive,
      startAt: body.startAt ?? null,
      endAt: body.endAt ?? null,
      sameIpLimit: body.sameIpLimit ?? null,
      sameDeviceLimit: body.sameDeviceLimit ?? null,
      perUserInviteLimit: body.perUserInviteLimit ?? null,
    };
    const program = await this.service.createProgram(data);
    return { code: 0, message: '已创建', data: program };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Put('programs/:id')
  async updateProgram(
    @Param('id') id: string,
    @Body() body: ProgramBody,
  ): Promise<ApiResponse<unknown>> {
    const update: UpdateProgramInput = { ...body };
    const program = await this.service.updateProgram(id, update);
    return { code: 0, message: '已更新', data: program };
  }

  @RequireAdminPermission('admin.page.referrals.manage')
  @Delete('programs/:id')
  async deleteProgram(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.service.deleteProgram(id);
    return { code: 0, message: '已删除', data: null };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('redemptions')
  async listRedemptions(
    @Query()
    query: {
      programId?: string;
      inviterUserId?: string;
      triggered?: string | boolean;
      page?: string;
      pageSize?: string;
    },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.listRedemptions({
      programId: query.programId?.trim() || undefined,
      inviterUserId: query.inviterUserId?.trim() || undefined,
      triggered: parseBooleanQuery(query.triggered),
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('leaderboard')
  async leaderboard(
    @Query() query: { programId?: string; days?: string },
  ): Promise<ApiResponse<unknown>> {
    const days = query.days ? parseInt(query.days, 10) : undefined;
    const data = await this.service.leaderboard({
      programId: query.programId?.trim() || undefined,
      days: Number.isFinite(days as number) ? (days as number) : undefined,
    });
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.referrals.view')
  @Get('summary')
  async summary(
    @Query() query: { programId?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.summary({
      programId: query.programId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data };
  }
}
