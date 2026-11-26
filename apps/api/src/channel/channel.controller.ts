import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ChannelService } from './channel.service';
import { RequireAdminPermission } from '../common/decorators/admin-permission.decorator';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { ApiResponse, paginationSchema } from '@ruidong/shared';

@ApiTags('Channels')
@Controller('admin/channels')
@UseGuards(AdminJwtAuthGuard, AdminPermissionGuard)
export class ChannelController {
  constructor(private readonly channelService: ChannelService) {}

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get()
  async list(@Query() query: unknown): Promise<ApiResponse<unknown>> {
    const parsed = paginationSchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    const data = await this.channelService.findAll(parsed.data.page, parsed.data.pageSize);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get('protocol-templates')
  async protocolTemplates(): Promise<ApiResponse<unknown>> {
    const data = this.channelService.getProtocolTemplates();
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.catalog.channels.view')
  @Get(':id')
  async get(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.findById(id);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post()
  async create(@Body() body: {
    name: string;
    provider: string;
    providerAccountIdentityId?: string | null;
    baseUrl: string;
    apiKey: string;
    models?: string;
    /** Per-model JSON override，shape 见 model-configs.ts */
    modelConfigs?: string;
    sdkType?: string;
    providerProfile?: string | null;
    clientCompatibility?: string | null;
    servedInboundProtocols?: string | string[] | null;
    served_inbound_protocols?: string | string[] | null;
    tokenCountStrategy?: string | null;
    ownedBy?: string | null;
    dedicatedClientProtocol?: string | null;
    dedicatedProtocolStrategy?: string | null;
    priority?: number;
    weight?: number;
    maxRpm?: number;
    maxTpm?: number;
    remark?: string;
  }): Promise<ApiResponse<unknown>> {
    if (!body.name || !body.provider || !body.baseUrl || !body.apiKey) {
      throw new BadRequestException('name, provider, baseUrl, apiKey 为必填');
    }
    const data = await this.channelService.create(body);
    return { code: 0, message: '创建成功', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post('publisher-compile-preview')
  async publisherCompilePreview(@Body() body: {
    name?: string;
    provider: string;
    baseUrl: string;
    sdkType?: string;
    providerProfile?: string | null;
    clientCompatibility?: string | string[] | null;
    servedInboundProtocols?: string | string[] | null;
    served_inbound_protocols?: string | string[] | null;
    tokenCountStrategy?: string | null;
    ownedBy?: string | null;
  }): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.previewPublisherCompile(body);
    return { code: 0, message: 'ok', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.update(id, body as never);
    return { code: 0, message: '更新成功', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    await this.channelService.remove(id);
    return { code: 0, message: '删除成功', data: null };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post(':id/test')
  async test(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.test(id);
    return { code: 0, message: data.success ? '连接成功' : '连接失败', data };
  }

  @RequireAdminPermission('admin.data.channels.manage')
  @Post(':id/reset-stats')
  async resetStats(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.resetStats(id);
    return { code: 0, message: '统计已重置', data };
  }

  /**
   * 从上游 /v1/models 端点拉取可用模型列表。
   * - 用 channel 配置的 baseUrl + apiKey 调用上游
   * - 返回模型 id 数组,前端弹窗多选后回写 channel.models
   * - 失败仅返错误信息,不修改 channel 自身
   */
  @RequireAdminPermission('admin.data.channels.manage')
  @Post(':id/discover-models')
  async discoverModels(@Param('id') id: string): Promise<ApiResponse<unknown>> {
    const data = await this.channelService.discoverModels(id);
    return {
      code: 0,
      message: data.success ? '拉取成功' : '拉取失败',
      data,
    };
  }
}
