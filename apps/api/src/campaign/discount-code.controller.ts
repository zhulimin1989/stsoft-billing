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
import {
  DiscountCodeService,
  CreateDiscountCodeInput,
  UpdateDiscountCodeInput,
} from './discount-code.service';
import { ApiResponse } from '@ruidong/shared';

@ApiTags('Admin Discount Codes')
@Controller('admin/discount-codes')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class DiscountCodeController {
  constructor(private readonly discountCodeService: DiscountCodeService) {}

  @Get()
  @RequireAdminPermission('admin.page.discount_codes.view')
  async list(@Query('isActive') isActive?: string): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.findAll({
      isActive: isActive === undefined ? undefined : isActive === 'true',
    });
    return { code: 0, message: 'ok', data };
  }

  @Get(':id')
  @RequireAdminPermission('admin.page.discount_codes.view')
  async getOne(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.findById(id);
    return { code: 0, message: 'ok', data };
  }

  @Get(':id/stats')
  @RequireAdminPermission('admin.page.discount_codes.view')
  async stats(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.stats(id);
    return { code: 0, message: 'ok', data };
  }

  @Post()
  @RequireAdminPermission('admin.page.discount_codes.manage')
  async create(@Body() body: CreateDiscountCodeInput): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.create(body);
    return { code: 0, message: 'ok', data };
  }

  @Put(':id')
  @RequireAdminPermission('admin.page.discount_codes.manage')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateDiscountCodeInput,
  ): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.update(id, body);
    return { code: 0, message: 'ok', data };
  }

  @Delete(':id')
  @RequireAdminPermission('admin.page.discount_codes.manage')
  async disable(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.discountCodeService.disable(id);
    return { code: 0, message: 'ok', data };
  }
}
