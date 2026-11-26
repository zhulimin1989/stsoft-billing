/**
 * CreditPolicyController — admin v2 信用额度策略 HTTP 入口。
 *
 * 路由前缀 /admin/v2/credit-policy(前端 stub apps/admin/src/api/v2/creditPolicy.ts 已固定)。
 * 权限沿用 admin.plans —— 信用额度属产品计费配置。
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-credit-policy-design.md
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreditPolicyRecoveryCondition,
  CreditPolicyTriggerAction,
} from '@prisma/client';
import { ApiResponse } from '@ruidong/shared';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { CreditPolicyService, CreditPolicyWriteInput } from './credit-policy.service';

interface UpsertGlobalBody {
  productId?: string;
  allowOverdraft?: boolean;
  defaultCreditLimitCents?: number;
  triggerAction?: CreditPolicyTriggerAction;
  recoveryCondition?: CreditPolicyRecoveryCondition;
  recoveryDays?: number | null;
}

interface UpsertSegmentBody extends UpsertGlobalBody {
  segmentId?: string;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 把 body 中可写字段抽出,丢弃 productId / segmentId 等定位字段。 */
function pickWriteInput(body: UpsertGlobalBody): CreditPolicyWriteInput {
  return {
    allowOverdraft: body.allowOverdraft,
    defaultCreditLimitCents: body.defaultCreditLimitCents,
    triggerAction: body.triggerAction,
    recoveryCondition: body.recoveryCondition,
    recoveryDays: body.recoveryDays ?? undefined,
  };
}

@ApiTags('AdminV2 / CreditPolicy')
@Controller('admin/v2/credit-policy')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class CreditPolicyController {
  constructor(private readonly service: CreditPolicyService) {}

  @RequireAdminPermission('admin.page.credit_policy.view')
  @Get('global')
  async getGlobal(
    @Query('productId') productId: string,
  ): Promise<ApiResponse<unknown>> {
    if (!productId) throw new BadRequestException('productId 必填');
    const data = await this.service.getGlobal(productId);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.manage')
  @Put('global')
  async upsertGlobal(@Body() body: UpsertGlobalBody): Promise<ApiResponse<unknown>> {
    const productId = (body?.productId ?? '').toString().trim();
    if (!productId) throw new BadRequestException('productId 必填');
    const data = await this.service.upsertGlobal(productId, pickWriteInput(body));
    return { code: 0, message: '已保存', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.view')
  @Get('segments')
  async listSegments(
    @Query('productId') productId: string,
  ): Promise<ApiResponse<unknown>> {
    if (!productId) throw new BadRequestException('productId 必填');
    const items = await this.service.listSegments(productId);
    return { code: 0, message: 'ok', data: { items } };
  }

  /**
   * P2-C review note(Minor #5): HTTP method 语义说明。
   *
   * GLOBAL 路径用 PUT /global —— 单条策略,(productId, scope=GLOBAL) 唯一,语义为 "替换/更新"。
   * SEGMENT 路径用 POST /segments —— 多条策略集合,路径不带 :id,
   * service 层按 (productId, segmentId) 做 upsert(找不到则 create)。
   *
   * 不改为 PUT 的原因:spec §8 路由表已固定 POST,前端 stub
   * apps/admin/src/api/v2/creditPolicy.ts 也是 POST,改 method 会引入兼容性问题。
   */
  @RequireAdminPermission('admin.page.credit_policy.manage')
  @Post('segments')
  async upsertSegment(@Body() body: UpsertSegmentBody): Promise<ApiResponse<unknown>> {
    const productId = (body?.productId ?? '').toString().trim();
    const segmentId = (body?.segmentId ?? '').toString().trim();
    if (!productId) throw new BadRequestException('productId 必填');
    if (!segmentId) throw new BadRequestException('segmentId 必填');
    const data = await this.service.upsertSegment({
      productId,
      segmentId,
      data: pickWriteInput(body),
    });
    return { code: 0, message: '已保存', data };
  }

  @RequireAdminPermission('admin.page.credit_policy.view')
  @Get('overdue-users')
  async listOverdueUsers(
    @Query() query: { productId?: string; page?: string; pageSize?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.service.listOverdueUsers({
      productId: query.productId?.trim() || undefined,
      page: parseInteger(query.page, 1),
      pageSize: parseInteger(query.pageSize, 20),
    });
    return { code: 0, message: 'ok', data };
  }
}
