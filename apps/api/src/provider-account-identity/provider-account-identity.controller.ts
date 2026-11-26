import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ApiResponse } from '@ruidong/shared';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { BillingInternalGuard } from '../billing-runtime/billing-internal.guard';
import { ProviderAccountIdentityService } from './provider-account-identity.service';

@ApiTags('Provider Account Identities')
@Controller('internal/billing/admin/provider-account-identities')
@Public()
@UseGuards(BillingInternalGuard, AdminPermissionGuard)
export class ProviderAccountIdentityController {
  constructor(private readonly identities: ProviderAccountIdentityService) {}

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get()
  async list(
    @Query() query: { providerCode?: string; status?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.identities.list(query);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post()
  async create(
    @Body() body: { providerCode?: string; displayName?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.identities.create(body);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post(':id/deactivate')
  async deactivate(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.identities.deactivate(id);
    return { code: 0, message: '已停用', data };
  }
}
