import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { BillingAdminService } from '../billing/billing.admin.service';
import { Public } from '../common/decorators/public.decorator';
import { BillingInternalGuard } from './billing-internal.guard';

function parseRecentOrderLimit(raw: string | undefined): number {
  if (raw === undefined) return 5;
  const parsed = Number.parseInt(raw, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  return Math.min(Math.max(limit, 1), 20);
}

@ApiTags('Billing Account Context')
@Controller('internal/billing/account')
@Public()
@UseGuards(BillingInternalGuard)
export class BillingAccountContextController {
  constructor(private readonly billingAdmin: BillingAdminService) {}

  @Get('users/:id/recent-orders')
  async listRecentOrdersForUser(
    @Param('id') userId: string,
    @Query('limit') rawLimit?: string,
  ): Promise<ApiResponse<unknown>> {
    const items = await this.billingAdmin.listRecentOrdersForUser(
      userId,
      parseRecentOrderLimit(rawLimit),
    );
    return { code: 0, message: 'ok', data: { items } };
  }
}
