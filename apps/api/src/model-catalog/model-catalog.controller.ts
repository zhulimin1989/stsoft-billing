import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { ModelCatalogService } from './model-catalog.service';

/**
 * User-facing model catalog API. Auth is enforced by the billing runtime's
 * global guard; users must be logged in to browse the catalog.
 *
 * Product-scoped requests are filtered by product model availability. The
 * response shape strips internal admin-only fields so user-facing UI cannot
 * leak admin state.
 */
@ApiTags('Models / Catalog')
@Controller({ path: 'models/catalog', version: '1' })
export class ModelCatalogController {
  constructor(private readonly service: ModelCatalogService) {}

  @Get()
  async list(
    @Query() query: { provider?: string; tag?: string; productId?: string },
  ): Promise<ApiResponse<unknown>> {
    const items = await this.service.list({
      provider: query?.provider?.trim() || undefined,
      tag: query?.tag?.trim() || undefined,
      productId: query?.productId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data: { items } };
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
    @Query() query: { productId?: string },
  ): Promise<ApiResponse<unknown>> {
    const item = await this.service.getOne(decodeURIComponent(id), {
      productId: query?.productId?.trim() || undefined,
    });
    return { code: 0, message: 'ok', data: item };
  }
}
