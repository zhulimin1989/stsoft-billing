import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { CampaignService, CreateCampaignInput, UpdateCampaignInput } from './campaign.service';
import { ApiResponse } from '@ruidong/shared';

@ApiTags('Admin Campaigns')
@Controller('admin/campaigns')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Get()
  @RequireAdminPermission('admin.page.campaigns.view')
  async list(
    @Query('planId') planId?: string,
    @Query('productId') productId?: string,
    @Query('isActive') isActive?: string,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.findAll({
      planId,
      productId,
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
    return { code: 0, message: 'ok', data };
  }

  @Get(':id')
  @RequireAdminPermission('admin.page.campaigns.view')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.findById(id);
    return { code: 0, message: 'ok', data };
  }

  @Get(':id/stats')
  @RequireAdminPermission('admin.page.campaigns.view')
  async stats(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.stats(id);
    return { code: 0, message: 'ok', data };
  }

  @Post()
  @RequireAdminPermission('admin.page.campaigns.manage')
  async create(@Body() body: CreateCampaignInput): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.create(body);
    return { code: 0, message: 'ok', data };
  }

  @Put(':id')
  @RequireAdminPermission('admin.page.campaigns.manage')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCampaignInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.update(id, body);
    return { code: 0, message: 'ok', data };
  }

  @Delete(':id')
  @RequireAdminPermission('admin.page.campaigns.manage')
  async disable(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.campaignService.disable(id);
    return { code: 0, message: 'ok', data };
  }
}
