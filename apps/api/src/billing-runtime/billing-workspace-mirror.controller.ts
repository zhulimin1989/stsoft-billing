import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { Public } from '../common/decorators/public.decorator';
import { BillingInternalGuard } from './billing-internal.guard';
import {
  BillingWorkspaceMirrorRequest,
  BillingWorkspaceMirrorService,
} from './billing-workspace-mirror.service';

@ApiTags('Billing Workspace Mirror')
@Controller('internal/billing/admin/workspaces')
@Public()
@UseGuards(BillingInternalGuard)
export class BillingWorkspaceMirrorController {
  constructor(private readonly workspaceMirror: BillingWorkspaceMirrorService) {}

  @Post('mirror')
  async mirror(@Body() body: BillingWorkspaceMirrorRequest): Promise<ApiResponse<unknown>> {
    return {
      code: 0,
      message: 'ok',
      data: await this.workspaceMirror.mirror(body),
    };
  }
}
