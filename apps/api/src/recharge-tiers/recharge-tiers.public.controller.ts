import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { Public } from '../common/decorators/public.decorator';
import { RechargeTiersService } from './recharge-tiers.service';

@ApiTags('Billing / RechargeTiers')
@Controller('billing/recharge-tiers')
export class PublicRechargeTiersController {
  constructor(private readonly service: RechargeTiersService) {}

  @Public()
  @Get()
  async list(
    @Query('productId') productId?: string,
  ): Promise<ApiResponse<unknown>> {
    const normalizedProductId = productId?.trim();
    if (!normalizedProductId) {
      throw new BadRequestException('productId 必填');
    }

    const data = await this.service.listPublicActive(normalizedProductId);
    return { code: 0, message: 'ok', data };
  }
}
