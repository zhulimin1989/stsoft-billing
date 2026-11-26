import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import {
  AddProductChannelGroupMemberInput,
  CreateDeliverySettingInput,
  CreateProductChannelGroupInput,
  CreateProductChannelInput,
  CreateRouteAssignmentInput,
  RouteAssignmentFilters,
  UpdateProductChannelGroupInput,
  UpdateProductChannelGroupMemberInput,
  UpdateProductChannelInput,
  UpdateRouteAssignmentInput,
} from '../product-route/product-route.dto';
import { ProductRouteService } from '../product-route/product-route.service';
import { BillingInternalGuard } from './billing-internal.guard';

function parseBooleanQuery(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'true' || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === '0') return false;
  return undefined;
}

@ApiTags('Billing Product Routes')
@Controller('internal/billing/admin/products/:productId')
@Public()
@UseGuards(BillingInternalGuard, AdminPermissionGuard)
export class ProductRouteAdminController {
  constructor(private readonly productRoute: ProductRouteService) {}

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('channels')
  async listProductChannels(@Param('productId') productId: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.productRoute.listProductChannels(productId) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Post('channels')
  async createProductChannel(
    @Param('productId') productId: string,
    @Body() body: CreateProductChannelInput,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '创建成功', data: await this.productRoute.createProductChannel(productId, body) };
  }

  @RequireAdminPermission('admin.page.delivery_settings.manage')
  @Post('delivery-settings')
  async createDeliverySetting(
    @Param('productId') productId: string,
    @Body() body: CreateDeliverySettingInput,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '投放设置已保存',
      data: await this.productRoute.createDeliverySetting(productId, body),
    };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Put('channels/:productChannelId')
  async updateProductChannel(
    @Param('productId') productId: string,
    @Param('productChannelId') productChannelId: string,
    @Body() body: UpdateProductChannelInput,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '更新成功',
      data: await this.productRoute.updateProductChannel(productId, productChannelId, body),
    };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Delete('channels/:productChannelId')
  async deleteProductChannel(
    @Param('productId') productId: string,
    @Param('productChannelId') productChannelId: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '删除成功',
      data: await this.productRoute.deleteProductChannel(productId, productChannelId),
    };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('channel-groups')
  async listGroups(@Param('productId') productId: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.productRoute.listGroups(productId) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Post('channel-groups')
  async createGroup(
    @Param('productId') productId: string,
    @Body() body: CreateProductChannelGroupInput,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '创建成功', data: await this.productRoute.createGroup(productId, body) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Put('channel-groups/:groupId')
  async updateGroup(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Body() body: UpdateProductChannelGroupInput,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '更新成功', data: await this.productRoute.updateGroup(productId, groupId, body) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Delete('channel-groups/:groupId')
  async deleteGroup(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '删除成功',
      data: await this.productRoute.deleteGroup(productId, groupId),
    };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Post('channel-groups/:groupId/members')
  async addGroupMember(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Body() body: AddProductChannelGroupMemberInput,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '添加成功',
      data: await this.productRoute.addGroupMember(productId, groupId, body),
    };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Put('channel-groups/:groupId/members/:memberId')
  async updateGroupMember(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
    @Body() body: UpdateProductChannelGroupMemberInput,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '更新成功',
      data: await this.productRoute.updateGroupMember(productId, groupId, memberId, body),
    };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Delete('channel-groups/:groupId/members/:memberId')
  async removeGroupMember(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Param('memberId') memberId: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '删除成功',
      data: await this.productRoute.removeGroupMember(productId, groupId, memberId),
    };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('route-assignments')
  async listAssignments(
    @Param('productId') productId: string,
    @Query() query: RouteAssignmentFilters & { isActive?: string },
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.productRoute.listAssignments(productId, {
        ...query,
        isActive: parseBooleanQuery(query?.isActive),
      }),
    };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Post('route-assignments')
  async createAssignment(
    @Param('productId') productId: string,
    @Body() body: CreateRouteAssignmentInput,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '创建成功', data: await this.productRoute.createAssignment(productId, body) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Put('route-assignments/:id')
  async updateAssignment(
    @Param('productId') productId: string,
    @Param('id') id: string,
    @Body() body: UpdateRouteAssignmentInput,
  ): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '更新成功', data: await this.productRoute.updateAssignment(productId, id, body) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Delete('route-assignments/:id')
  async deleteAssignment(
    @Param('productId') productId: string,
    @Param('id') id: string,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: '删除成功',
      data: await this.productRoute.deleteAssignment(productId, id),
    };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('route-graph/preview')
  async previewRouteGraph(@Param('productId') productId: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: 'ok', data: await this.productRoute.compileRouteGraph(productId) };
  }

  @RequireAdminPermission('admin.data.delivery_routes.manage')
  @Post('route-graph/rebuild')
  async rebuildRouteGraph(@Param('productId') productId: string): Promise<ApiResponse<unknown>> {
    return { code: 0, message: '已重推', data: await this.productRoute.rebuildRouteGraph(productId) };
  }
}
