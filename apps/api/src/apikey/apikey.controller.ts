import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Param,
  Body,
  BadRequestException,
  Headers,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiKeyService } from './apikey.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ApiResponse, ApiKey, createApiKeySchema } from '@ruidong/shared';

/**
 * Legacy `/api/apikeys` controller.
 *
 * `billing-main.ts` mounts `BillingRuntimeModule`, which does not import
 * `ApiKeyModule`; current deployed API key routes live in `codesphere-user`.
 */
@ApiTags('API Keys')
@Controller('apikeys')
export class ApiKeyController {
  constructor(
    private readonly apiKeyService: ApiKeyService,
  ) {}

  @Public()
  @Get('models')
  async getApiModels() {
    const data = await this.apiKeyService.listAvailableModels();
    return { code: 0, message: 'ok', data };
  }

  @Post()
  async createKey(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Body() body: unknown,
  ): Promise<ApiResponse<{ key: ApiKey; plainKey: string }>> {
    const parsed = createApiKeySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0].message);
    }

    const result = await this.apiKeyService.createKey(
      userId,
      parsed.data.name,
      parsed.data.allowedModels,
      parsed.data.budgetCents ?? null,
      parsed.data.productId ?? null,
      parsed.data.codingPlanEntitlementId ?? null,
      tenantId ?? null,
    );
    return { code: 0, message: '创建成功，请妥善保存 Key（仅显示一次）', data: result };
  }

  @Get()
  async getUserKeys(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
  ): Promise<ApiResponse<ApiKey[]>> {
    const keys = await this.apiKeyService.getUserKeys(userId, tenantId);
    return { code: 0, message: 'ok', data: keys };
  }

  @Delete(':id')
  async deleteKey(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Param('id') keyId: string,
  ): Promise<ApiResponse<null>> {
    await this.apiKeyService.deleteKey(keyId, userId, tenantId);
    return { code: 0, message: '删除成功', data: null };
  }

  @Patch(':id/toggle')
  async toggleKey(
    @CurrentUser('id') userId: string,
    @Headers('x-tenant-id') tenantId: string | undefined,
    @Param('id') keyId: string,
    @Body('isActive') isActive: boolean,
  ): Promise<ApiResponse<ApiKey>> {
    const key = await this.apiKeyService.toggleKey(keyId, userId, isActive, tenantId);
    return { code: 0, message: isActive ? '已启用' : '已停用', data: key };
  }
}
