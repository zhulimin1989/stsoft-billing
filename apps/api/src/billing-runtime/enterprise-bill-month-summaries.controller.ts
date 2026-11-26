import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiResponse } from '@ruidong/shared';
import { Public } from '../common/decorators/public.decorator';
import { BillingInternalGuard } from './billing-internal.guard';
import { EnterpriseBillsService } from '../billing/enterprise-bills.service';
import { EnterpriseAccountService } from '../billing/enterprise-account.service';

/**
 * K8s / 手动调度。close 按 listBills 现算同步已闭月汇总（可带 billingAccountId）；
 * refresh 刷当前北京月。
 */
@ApiTags('Enterprise bill month summaries (internal)')
@Controller('internal/billing/admin/v2/enterprise-bill-month-summaries')
@Public()
@UseGuards(BillingInternalGuard)
export class EnterpriseBillMonthSummariesController {
  constructor(
    private readonly bills: EnterpriseBillsService,
    private readonly accounts: EnterpriseAccountService,
  ) {}

  @Post('close')
  async close(
    @Body() body?: { billingAccountId?: string },
  ): Promise<ApiResponse<unknown>> {
    const data = await this.bills.closeHistoricalClosedMonths(new Date(), {
      billingAccountId: body?.billingAccountId,
    });
    return { code: 0, message: 'ok', data };
  }

  @Post('refresh')
  async refresh(): Promise<ApiResponse<unknown>> {
    const data = await this.bills.refreshCurrentMonthSummaries(
      new Date(),
      () => this.accounts.refreshFundingSnapshots(),
    );
    return { code: 0, message: 'ok', data };
  }
}
