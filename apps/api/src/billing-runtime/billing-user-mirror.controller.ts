import { Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { Public } from '../common/decorators/public.decorator';
import { BillingInternalGuard } from './billing-internal.guard';
import {
  BillingUserMirrorService,
  type BillingUserMirrorSnapshot,
} from './billing-user-mirror.service';

@ApiTags('Billing User Mirror')
@Controller('internal/billing/admin/users')
@Public()
@UseGuards(BillingInternalGuard)
export class BillingUserMirrorController {
  constructor(private readonly userMirror: BillingUserMirrorService) {}

  @Put(':id/mirror')
  async mirrorUser(
    @Param('id') id: string,
    @Body() body: BillingUserMirrorSnapshot,
  ): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.userMirror.mirrorUser({ ...body, id }),
    };
  }
}
